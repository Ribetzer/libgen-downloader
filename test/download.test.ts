import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { stubPartFileRename } from "./support/fs-mock";
import { downloadFile } from "../src/api/data/download";

// A directory that does not exist, so the "already downloaded" check always
// reports a clean slate and nothing touches the working tree.
const OUTPUT_DIRECTORY = path.join(os.tmpdir(), "libgen-downloader-test-output");

const createResponse = (filename: string, chunks: Uint8Array[]) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(chunks.reduce((total, chunk) => total + chunk.length, 0)),
    },
  });
};

afterEach(() => {
  mock.restore();
});

describe("downloadFile", () => {
  it("gives up on a transfer that goes silent without closing", async () => {
    // The failure this exists for: libgen stops sending but holds the socket
    // open, so nothing ever throws, `attempt` never retries, and the whole
    // sequential queue blocks behind one file. Observed wedged at 2.48 of
    // 3.36 MB for an hour.
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback();
      },
    });
    spyOn(fs, "createWriteStream").mockReturnValue(destination as fs.WriteStream);
    stubPartFileRename();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial"));
        // Never closed, never errored - exactly the wedged case.
      },
    });
    const response = new Response(body, {
      headers: {
        "content-disposition": 'attachment; filename="stalled.pdf"',
        "content-length": "999999",
      },
    });

    const promise = downloadFile({
      downloadStream: response,
      outputDirectory: OUTPUT_DIRECTORY,
      stallTimeoutMs: 50,
      onStart: () => {},
      onProgress: () => {},
    });

    // That this returns at all is the assertion: with `Readable.from` and no
    // watchdog the promise never settles and the test runner hangs.
    await expect(promise).rejects.toThrow(/no data for/);
  });

  it("writes every response chunk and reports progress", async () => {
    const writtenChunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writtenChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    spyOn(fs, "createWriteStream").mockReturnValue(destination as fs.WriteStream);
    stubPartFileRename();

    const onStart = mock(() => {});
    const receivedByteCounts: number[] = [];
    const chunks = [Buffer.from("first "), Buffer.from("second")];

    const result = await downloadFile({
      downloadStream: createResponse("example.epub", chunks),
      outputDirectory: OUTPUT_DIRECTORY,
      onStart,
      onProgress: (_filename, receivedBytes) => receivedByteCounts.push(receivedBytes),
    });

    expect(result).toEqual({
      path: path.join(OUTPUT_DIRECTORY, "example.epub"),
      filename: "example.epub",
      total: 12,
      skipped: false,
    });
    expect(Buffer.concat(writtenChunks).toString()).toBe("first second");
    expect(onStart).toHaveBeenCalledWith("example.epub", 12);
    // Cumulative for this attempt, not per-chunk deltas.
    expect(receivedByteCounts).toEqual([6, 12]);
  });

  it("rejects when the response has no content-disposition header", async () => {
    await expect(
      downloadFile({
        downloadStream: new Response("content"),
        outputDirectory: OUTPUT_DIRECTORY,
        onStart() {},
        onProgress() {},
      })
    ).rejects.toThrow("No content-disposition header found");
  });

  it("skips a file that is already on disk at the full size", async () => {
    const createWriteStream = spyOn(fs, "createWriteStream");
    spyOn(fs.promises, "stat").mockResolvedValue({
      isFile: () => true,
      size: 12,
    } as fs.Stats);

    const result = await downloadFile({
      downloadStream: createResponse("example.epub", [
        Buffer.from("first "),
        Buffer.from("second"),
      ]),
      outputDirectory: OUTPUT_DIRECTORY,
      onStart() {},
      onProgress() {},
    });

    expect(result.skipped).toBe(true);
    expect(createWriteStream).not.toHaveBeenCalled();
  });

  it("writes beside a same-named file of a different size", async () => {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const createWriteStream = spyOn(fs, "createWriteStream").mockReturnValue(
      destination as fs.WriteStream
    );
    stubPartFileRename();
    const stat = spyOn(fs.promises, "stat");
    stat.mockResolvedValueOnce({ isFile: () => true, size: 999 } as fs.Stats);
    stat.mockRejectedValue(new Error("ENOENT"));

    const result = await downloadFile({
      downloadStream: createResponse("example.epub", [
        Buffer.from("first "),
        Buffer.from("second"),
      ]),
      outputDirectory: OUTPUT_DIRECTORY,
      onStart() {},
      onProgress() {},
    });

    expect(result.skipped).toBe(false);
    expect(result.path).toBe(path.join(OUTPUT_DIRECTORY, "example (2).epub"));
    expect(createWriteStream).toHaveBeenCalledWith(
      path.join(OUTPUT_DIRECTORY, "example (2).epub.part"),
      { flags: "w" }
    );
  });

  it("handles a destroyed destination without writing to it again", async () => {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          destination.destroy();
        }, 0);
        callback();
      },
    });
    spyOn(fs, "createWriteStream").mockReturnValue(destination as fs.WriteStream);
    stubPartFileRename();

    let cancelled = false;
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(Buffer.alloc(1024));
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!cancelled) {
          controller.enqueue(Buffer.alloc(1024));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const downloadStream = new Response(body, {
      headers: {
        "content-disposition": 'attachment; filename="broken.epub"',
        "content-length": "2048",
      },
    });

    await expect(
      downloadFile({
        downloadStream,
        outputDirectory: OUTPUT_DIRECTORY,
        onStart() {},
        onProgress() {},
      })
    ).rejects.toThrow("(broken.epub) Error occurred while downloading file");
  });
});
