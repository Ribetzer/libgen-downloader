import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { downloadByMD5, downloadFromURL } from "../src/api/data/download";
import {
  libgenFileCooldownUntil,
  libgenFileWaitMs,
  paceLibgenFile,
  readBusyPage,
  readFileLimit,
  resetLibgenFilePacing,
} from "../src/api/data/libgen-file-pacing";
import { LIBGEN_FILE_MIN_INTERVAL_MS } from "../src/settings";
import { mockFetch } from "./support/fetch-mock";
import { stubPartFileRename } from "./support/fs-mock";

const MD5 = "833dce9876be889d5d14be6a68d968f6";

// The CDN's own words, captured from cdn4.booksdl.lc through the VPN.
const LIMIT_PAGE =
  '<h1 style="color:#A00000">Error</h1><p>You have downloaded too much files (15) in the last 300 seconds, please wait';

const detailPage =
  '<table id="main"><tr><td>Book</td><td><a href="https://first.example/get.php?md5=x&key=y">GET</a></td></tr></table>';

const fileResponse = () =>
  new Response("downloaded content", {
    headers: {
      "content-disposition": 'attachment; filename="paper.pdf"',
      "content-length": "18",
    },
  });

const noopCallbacks = {
  outputDirectory: path.join(os.tmpdir(), "libgen-downloader-pacing-test"),
  onStart: () => {},
  onProgress: () => {},
};

const discardWrites = () => {
  stubPartFileRename();
  spyOn(fs, "createWriteStream").mockImplementation(
    () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as fs.WriteStream
  );
};

afterEach(() => {
  mock.restore();
});

describe("readFileLimit", () => {
  it("reads the window and the quota off the CDN's limit page", () => {
    expect(readFileLimit(LIMIT_PAGE)).toEqual({ windowMs: 300_000, files: 15 });
  });

  it("ignores any other error page", () => {
    expect(readFileLimit("<h1>Internal Server Error</h1>")).toBeUndefined();
    expect(readFileLimit("")).toBeUndefined();
  });
});

describe("libgenFileWaitMs", () => {
  it("spaces requests by the interval", () => {
    expect(libgenFileWaitMs(1000, 0, 0, 21_000)).toBe(20_000);
    expect(libgenFileWaitMs(30_000, 0, 0, 21_000)).toBe(0);
  });

  it("holds every request until a cooldown has passed", () => {
    expect(libgenFileWaitMs(1000, 0, 301_000, 21_000)).toBe(300_000);
  });

  it("stays under 15 files per 300 seconds", () => {
    expect(LIBGEN_FILE_MIN_INTERVAL_MS * 15).toBeGreaterThan(300_000);
  });
});

/**
 * Records the waits asked for instead of sleeping. Timing real sleeps is no
 * good here anyway: another file stubs `delay` through `mock.module`, which
 * Bun does not undo between files.
 */
const recordWaits = async (): Promise<number[]> => {
  const utilities = await import("../src/utilities");
  const waits: number[] = [];
  mock.module("../src/utilities", () => ({
    ...utilities,
    delay: async (ms: number) => {
      waits.push(ms);
    },
  }));
  return waits;
};

describe("paceLibgenFile", () => {
  it("makes requests arriving together take turns", async () => {
    const waits = await recordWaits();
    resetLibgenFilePacing(21_000);

    await Promise.all([1, 2, 3].map(() => paceLibgenFile()));

    // The first goes at once; each later one waits a further interval.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(20_000);
    expect(waits[1]).toBeGreaterThan(41_000);
  });
});

describe("downloadByMD5 at LibGen's file limit", () => {
  const candidate = {
    mirror: { src: "https://first.example/", type: "libgen-plus" as const },
    adapter: new LibgenPlusAdapter("https://first.example/"),
  };

  it("waits out the window the limit page names, then downloads", async () => {
    let fileRequests = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      fileRequests += 1;
      if (fileRequests === 1) {
        return new Response(LIMIT_PAGE, { status: 500 });
      }

      return fileResponse();
    });
    discardWrites();
    const waits = await recordWaits();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [candidate],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(retryMessages[0]).toContain("LibGen's download limit reached (15 files per 300s)");
    expect(retryMessages[0]).toContain("waiting 300s for it to clear, not counted as an attempt");
    expect(waits.some((ms) => ms > 290_000)).toBe(true);
    expect(fileRequests).toBe(2);
  });

  it("sets a cooldown every later LibGen file request honours", async () => {
    await recordWaits();
    let fileRequests = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      fileRequests += 1;
      if (fileRequests === 1) {
        return new Response(LIMIT_PAGE, { status: 500 });
      }

      return fileResponse();
    });
    discardWrites();

    await downloadByMD5({ md5: MD5, candidates: [candidate], ...noopCallbacks, retryDelayMs: 0 });

    expect(libgenFileCooldownUntil()).toBeGreaterThan(Date.now() + 290_000);
  });

  it("waits out any number of refusals, spending neither attempts nor budget", async () => {
    // A VPN exit shares the limit with strangers, so refusals can run on far
    // past the six attempts and the time budget - which used to fail the item.
    const waits = await recordWaits();
    let fileRequests = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      fileRequests += 1;
      if (fileRequests <= 7) {
        return new Response(LIMIT_PAGE, { status: 500 });
      }

      return fileResponse();
    });
    discardWrites();

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [candidate],
      ...noopCallbacks,
      retryDelayMs: 0,
      totalBudgetMs: 60_000,
    });

    expect(outcome.status).toBe("downloaded");
    // One cooldown per refusal, sat out by the pacer before the next request.
    expect(waits.filter((ms) => ms > 290_000)).toHaveLength(7);
  });

  it("leaves a plain server error to the ordinary retry", async () => {
    let fileRequests = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      fileRequests += 1;
      if (fileRequests === 1) {
        return new Response("<h1>Internal Server Error</h1>", { status: 500 });
      }

      return fileResponse();
    });
    discardWrites();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [candidate],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(retryMessages[0]).toContain("HTTP 500");
    expect(libgenFileCooldownUntil()).toBe(0);
  });
});

describe("downloadFromURL", () => {
  it("is not paced or read as LibGen, being some other host", async () => {
    const waits = await recordWaits();
    resetLibgenFilePacing(60_000);
    mockFetch(async () => fileResponse());
    discardWrites();

    await downloadFromURL({ downloadURL: "https://arxiv.example/paper.pdf", ...noopCallbacks });
    await downloadFromURL({ downloadURL: "https://arxiv.example/other.pdf", ...noopCallbacks });

    expect(waits).toHaveLength(0);
  });
});

// LibGen's download server when its database is out of connections, as
// captured through a lane on 24 September: an HTTP 500, for everyone.
const BUSY_PAGE_HTML =
  "<div class=\"alert alert-danger\" role=\"alert\"> 3306. User 'libgen_get' has exceeded the 'max_user_connections' resource (current value: 100)</div>";

describe("readBusyPage", () => {
  it("recognises the database running out of connections", () => {
    expect(readBusyPage(BUSY_PAGE_HTML)).toBe(true);
    expect(readBusyPage("SQLSTATE[HY000] [1040] Too many connections")).toBe(true);
  });

  it("leaves other pages alone", () => {
    expect(readBusyPage(LIMIT_PAGE)).toBe(false);
    expect(readBusyPage("<h1>Internal Server Error</h1>")).toBe(false);
  });
});

describe("downloadByMD5 against an overloaded LibGen", () => {
  const candidate = {
    mirror: { src: "https://first.example/", type: "libgen-plus" as const },
    adapter: new LibgenPlusAdapter("https://first.example/"),
  };

  it("waits out the server being overloaded without spending attempts", async () => {
    await recordWaits();
    let fileRequests = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      fileRequests += 1;
      // More overloaded answers than there are attempts.
      if (fileRequests <= 8) {
        return new Response(BUSY_PAGE_HTML, { status: 500 });
      }

      return fileResponse();
    });
    discardWrites();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [candidate],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(retryMessages[0]).toContain("LibGen's server is overloaded");
    expect(retryMessages[0]).toContain("not counted as an attempt");
  });

  it("says a page came back instead of the file, rather than a missing header", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return new Response("<html><title>Temporarily unavailable</title></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    discardWrites();

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [candidate],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome).toMatchObject({ status: "failed", transient: true });
    expect(outcome.status === "failed" && outcome.reason).toContain(
      "LibGen sent a page instead of the file: Temporarily unavailable"
    );
  });
});
