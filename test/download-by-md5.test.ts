import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { downloadByMD5, readRetryAfterMs } from "../src/api/data/download";
import { MAX_RETRY_AFTER_MS } from "../src/settings";
import type { MirrorCandidate } from "../src/api/data/resolve";
import { mockFetch } from "./support/fetch-mock";
import { stubPartFileRename } from "./support/fs-mock";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";

const createCandidate = (host: string): MirrorCandidate => ({
  mirror: { src: `https://${host}/`, type: "libgen-plus" },
  adapter: new LibgenPlusAdapter(`https://${host}/`),
});

const detailPage = (host: string) =>
  `<table id="main"><tr><td>Book</td><td><a href="https://${host}/files/book.epub">GET</a></td></tr></table>`;

const fileResponse = () =>
  new Response("downloaded content", {
    headers: {
      "content-disposition": 'attachment; filename="book.epub"',
      "content-length": "18",
    },
  });

const collectWrites = () => {
  const chunks: Buffer[] = [];
  stubPartFileRename();
  spyOn(fs, "createWriteStream").mockImplementation(
    () =>
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }) as fs.WriteStream
  );
  return chunks;
};

// A directory that does not exist, so nothing is ever seen as already present.
const OUTPUT_DIRECTORY = path.join(os.tmpdir(), "libgen-downloader-test-output");

const noopCallbacks = {
  outputDirectory: OUTPUT_DIRECTORY,
  onStart: () => {},
  onProgress: () => {},
};

afterEach(() => {
  mock.restore();
});

describe("readRetryAfterMs", () => {
  it("reads a delay given in seconds", () => {
    expect(readRetryAfterMs("30")).toBe(30_000);
  });

  it("reads a delay given as an HTTP date", () => {
    const inTwentySeconds = new Date(Date.now() + 20_000).toUTCString();
    const result = readRetryAfterMs(inTwentySeconds) || 0;

    expect(result).toBeGreaterThan(15_000);
    expect(result).toBeLessThanOrEqual(20_000);
  });

  it("caps a hostile value and ignores nonsense", () => {
    const missingHeader = new Response("").headers.get("retry-after");

    expect(readRetryAfterMs("99999")).toBe(MAX_RETRY_AFTER_MS);
    expect(readRetryAfterMs("soon")).toBeUndefined();
    expect(readRetryAfterMs(missingHeader)).toBeUndefined();
  });
});

describe("downloadByMD5", () => {
  it("backs off when a mirror answers 429, then completes", async () => {
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      if (fileRequestCount === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }

      return fileResponse();
    });
    collectWrites();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
      throttleBackoffMs: [0, 0, 0],
    });

    expect(outcome.status).toBe("downloaded");
    expect(retryMessages[0]).toContain("HTTP 429 (throttled)");
  });

  it("restarts a dropped transfer and reports the retry", async () => {
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      if (fileRequestCount === 1) {
        return new Response("gateway down", { status: 502 });
      }

      return fileResponse();
    });
    const chunks = collectWrites();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(fileRequestCount).toBe(2);
    expect(Buffer.concat(chunks).toString()).toBe("downloaded content");
    expect(retryMessages).toHaveLength(1);
    expect(retryMessages[0]).toContain("HTTP 502");
  });

  it("keeps the part file between attempts and clears it once it gives up", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      return fileResponse();
    });
    spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("connection reset"));
          },
        }) as fs.WriteStream
    );
    const rm = spyOn(fs.promises, "rm").mockImplementation(async () => {});

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error("Expected the transfer to fail");
    }
    expect(outcome.reason).toContain("first.example");
    expect(outcome.reason).toContain("book.epub");
    // Deleted once, at the end - not once per attempt. The part file is what
    // the next attempt would resume from, so removing it between tries would
    // throw away the only thing worth keeping. It never carries the real name,
    // so a caller cannot mistake it for a finished download in the meantime.
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(path.join(OUTPUT_DIRECTORY, "book.epub.part"), { force: true });
  });

  it("moves to another mirror when one resolves but cannot serve the file", async () => {
    mockFetch(async (input) => {
      const url = input.toString();

      if (url.includes("/ads.php")) {
        return new Response(detailPage(new URL(url).hostname));
      }

      if (url.startsWith("https://first.example/")) {
        return new Response("gone", { status: 500 });
      }

      return fileResponse();
    });
    collectWrites();

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    if (outcome.status !== "downloaded") {
      throw new Error("Expected the second mirror to serve the file");
    }
    expect(outcome.mirror.src).toBe("https://second.example/");
  });

  it("names the mirrors it checked when no mirror holds the record", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome).toEqual({
      status: "failed",
      reason: "not found on any mirror (first.example, second.example)",
    });
  });

  it("keeps restarting past the old three-attempt limit", async () => {
    // The case this whole change exists for: a link that drops repeatedly but
    // is not dead. Five failures then a success would have been given up on
    // under the previous count of 3.
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      if (fileRequestCount < 6) {
        return new Response("gateway down", { status: 502 });
      }

      return fileResponse();
    });
    const chunks = collectWrites();

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(fileRequestCount).toBe(6);
    expect(Buffer.concat(chunks).toString()).toBe("downloaded content");
  });

  it("reports how far the failed attempt got", async () => {
    // A transfer that moved 12 of 18 bytes and one that never started read
    // identically before this; the bytes are the only trace left, since the
    // partial file is deleted and the next attempt restarts from zero.
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      return fileResponse();
    });

    let written = 0;
    spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            written += chunk.length;
            // Fail the first attempt partway, then let the second through.
            if (fileRequestCount === 1) {
              callback(new Error("connection reset"));
              return;
            }

            callback();
          },
        }) as fs.WriteStream
    );
    spyOn(fs.promises, "rm").mockImplementation(async () => {});
    stubPartFileRename();
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(written).toBeGreaterThan(0);
    expect(retryMessages[0]).toContain("reached");
    expect(retryMessages[0]).toContain("of 0.0 MB");
  });

  it("stops starting attempts once the time budget is spent", async () => {
    // Attempt counts bound tries, not time. Budget of 0 means the very first
    // failure is the last: nothing should be retried after it.
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      return new Response("gateway down", { status: 502 });
    });
    const retryMessages: string[] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
      ...noopCallbacks,
      onRetry: (message) => retryMessages.push(message),
      retryDelayMs: 0,
      totalBudgetMs: 0,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error("Expected the transfer to fail");
    }
    expect(outcome.reason).toContain("out of time");
    expect(fileRequestCount).toBe(1);
    expect(retryMessages).toHaveLength(0);
  });

  it("asks to continue from what the last attempt left on disk", async () => {
    const rangeHeaders: (string | null)[] = [];
    let fileRequestCount = 0;
    mockFetch(async (input, init) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      rangeHeaders.push(new Headers(init?.headers).get("range"));
      return fileResponse();
    });
    // The real failure mode: the transfer starts, writes some bytes, then the
    // socket dies. A response-level failure (502) never reaches downloadFile,
    // so there would be no part file to resume from at all.
    spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            if (fileRequestCount === 1) {
              callback(new Error("connection reset"));
              return;
            }

            callback();
          },
        }) as fs.WriteStream
    );
    stubPartFileRename();
    spyOn(fs.promises, "rm").mockImplementation(async () => {});
    // Six bytes survived the first attempt.
    const stat = spyOn(fs.promises, "stat");
    // The real `stat` has several overloads; the download path only uses the
    // simple one, so the mock is narrowed to it rather than satisfying all.
    stat.mockImplementation((async (target: fs.PathLike) => {
      if (String(target).endsWith(".part")) {
        return { isFile: () => true, size: 6 } as fs.Stats;
      }

      throw new Error("ENOENT");
    }) as unknown as typeof fs.promises.stat);

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    // Nothing to resume from before the first attempt; afterwards it asks.
    expect(rangeHeaders[0]).toBeNull();
    expect(rangeHeaders[1]).toBe("bytes=6-");
  });

  it("appends when the server agrees to resume, and counts the bytes already held", async () => {
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      if (fileRequestCount === 1) {
        return fileResponse();
      }

      // The server honours it: only the tail, with the full size in
      // content-range rather than content-length.
      return new Response("content", {
        status: 206,
        headers: {
          "content-disposition": 'attachment; filename="book.epub"',
          "content-length": "7",
          "content-range": "bytes 11-17/18",
        },
      });
    });
    const flags: (string | undefined)[] = [];
    spyOn(fs, "createWriteStream").mockImplementation((_target, options) => {
      flags.push((options as { flags?: string } | undefined)?.flags);
      return new Writable({
        write(_chunk, _encoding, callback) {
          if (fileRequestCount === 1) {
            callback(new Error("connection reset"));
            return;
          }

          callback();
        },
      }) as fs.WriteStream;
    });
    stubPartFileRename();
    spyOn(fs.promises, "rm").mockImplementation(async () => {});
    const stat = spyOn(fs.promises, "stat");
    // The real `stat` has several overloads; the download path only uses the
    // simple one, so the mock is narrowed to it rather than satisfying all.
    stat.mockImplementation((async (target: fs.PathLike) => {
      if (String(target).endsWith(".part")) {
        return { isFile: () => true, size: 11 } as fs.Stats;
      }

      throw new Error("ENOENT");
    }) as unknown as typeof fs.promises.stat);
    const progress: number[][] = [];

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      outputDirectory: OUTPUT_DIRECTORY,
      onStart: () => {},
      onProgress: (_filename, receivedBytes, total) => progress.push([receivedBytes, total]),
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    // Appended, not truncated - the 11 bytes already on disk are kept.
    expect(flags.at(-1)).toBe("a");
    // Progress continues from 11 rather than restarting at 0, and the total is
    // the whole file from content-range, not the 7 bytes of this response.
    expect(progress.at(-1)).toEqual([18, 18]);
  });

  it("starts over when the server ignores the range request", async () => {
    // libgen's CDN does exactly this today: 200 and the whole file, however
    // politely you ask. The part file must be overwritten, not appended to,
    // or the finished file would carry a duplicated prefix.
    let fileRequestCount = 0;
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      fileRequestCount += 1;
      if (fileRequestCount === 1) {
        return new Response("gateway down", { status: 502 });
      }

      return fileResponse();
    });
    const flags: (string | undefined)[] = [];
    spyOn(fs, "createWriteStream").mockImplementation((_target, options) => {
      flags.push((options as { flags?: string } | undefined)?.flags);
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as fs.WriteStream;
    });
    stubPartFileRename();
    const stat = spyOn(fs.promises, "stat");
    // The real `stat` has several overloads; the download path only uses the
    // simple one, so the mock is narrowed to it rather than satisfying all.
    stat.mockImplementation((async (target: fs.PathLike) => {
      if (String(target).endsWith(".part")) {
        return { isFile: () => true, size: 6 } as fs.Stats;
      }

      throw new Error("ENOENT");
    }) as unknown as typeof fs.promises.stat);

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("downloaded");
    expect(flags.at(-1)).toBe("w");
  });

  it("widens the gap between restarts and clamps at the last step", async () => {
    // The message rounds to whole seconds, so asserting through it would mean
    // really waiting seconds. `delay` is stubbed instead: the gaps are
    // recorded and nothing sleeps.
    const utilities = await import("../src/utilities");
    const waits: number[] = [];
    mock.module("../src/utilities", () => ({
      ...utilities,
      delay: async (ms: number) => {
        waits.push(ms);
      },
    }));

    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage("first.example"));
      }

      return new Response("gateway down", { status: 502 });
    });

    const outcome = await downloadByMD5({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      ...noopCallbacks,
      backoffMs: [1000, 2000, 4000],
      totalBudgetMs: 10 * 60_000,
    });

    expect(outcome.status).toBe("failed");
    // Five gaps for six attempts, rising then holding at the final entry.
    expect(waits).toEqual([1000, 2000, 4000, 4000, 4000]);
  });
});
