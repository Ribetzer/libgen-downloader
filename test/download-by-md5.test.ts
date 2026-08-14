import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import { Writable } from "node:stream";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { downloadByMD5 } from "../src/api/data/download";
import type { MirrorCandidate } from "../src/api/data/resolve";
import { mockFetch } from "./support/fetch-mock";

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

const noopCallbacks = {
  onStart: () => {},
  onData: () => {},
};

afterEach(() => {
  mock.restore();
});

describe("downloadByMD5", () => {
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

  it("deletes the truncated file and reports the reason when transfers keep failing", async () => {
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
    expect(rm).toHaveBeenCalledTimes(3);
    expect(rm).toHaveBeenCalledWith("./book.epub", { force: true });
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
});
