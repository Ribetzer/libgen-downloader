import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import { Writable } from "node:stream";
import { downloadFile } from "../src/api/data/download";

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
  it("writes every response chunk and reports progress", async () => {
    const writtenChunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writtenChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    spyOn(fs, "createWriteStream").mockReturnValue(destination as fs.WriteStream);

    const onStart = mock(() => {});
    const onData = mock(() => {});
    const chunks = [Buffer.from("first "), Buffer.from("second")];

    const result = await downloadFile({
      downloadStream: createResponse("example.epub", chunks),
      onStart,
      onData,
    });

    expect(result).toEqual({
      path: "./example.epub",
      filename: "example.epub",
      total: 12,
    });
    expect(Buffer.concat(writtenChunks).toString()).toBe("first second");
    expect(onStart).toHaveBeenCalledWith("example.epub", 12);
    expect(onData).toHaveBeenCalledTimes(2);
  });

  it("rejects when the response has no content-disposition header", async () => {
    await expect(
      downloadFile({
        downloadStream: new Response("content"),
        onStart() {},
        onData() {},
      })
    ).rejects.toThrow("No content-disposition header found");
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
        onStart() {},
        onData() {},
      })
    ).rejects.toThrow("(broken.epub) Error occurred while downloading file");
  });
});
