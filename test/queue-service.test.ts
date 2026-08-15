import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ItemStore, QueueItem } from "../src/server/database";
import { MirrorService } from "../src/server/mirror-service";
import { QueueService } from "../src/server/queue-service";
import { mockFetch } from "./support/fetch-mock";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";
const OUTPUT_DIRECTORY = path.join(os.tmpdir(), "libgen-downloader-queue-test");

const detailPage =
  '<table id="main"><tr><td>Book</td><td><a href="https://first.example/files/book.epub">GET</a></td></tr></table>';

const fileResponse = () =>
  new Response("downloaded content", {
    headers: {
      "content-disposition": 'attachment; filename="book.epub"',
      "content-length": "18",
    },
  });

/** A mirror service pinned to one mirror, with no config fetch involved. */
const createMirrorService = (): MirrorService => {
  const service = new MirrorService();
  const mirror = { src: "https://first.example/", type: "libgen-plus" as const };
  service.use([mirror], mirror);
  return service;
};

const waitForIdle = (queue: QueueService) =>
  new Promise<void>((resolve) => {
    const unsubscribe = queue.subscribe((event) => {
      if (event.type === "queue-idle") {
        unsubscribe();
        resolve();
      }
    });
  });

let store: ItemStore;

beforeEach(() => {
  store = new ItemStore(":memory:");
  spyOn(fs, "createWriteStream").mockImplementation(
    () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as fs.WriteStream
  );
});

afterEach(() => {
  store.close();
  mock.restore();
});

describe("ItemStore", () => {
  it("requeues work that a restart interrupted", () => {
    const item = store.add(MD5, "Interrupted");
    store.update(item.id, { status: "downloading", progress: 500 });

    const recovered = store.recoverInterrupted();

    expect(recovered).toBe(1);
    expect(store.get(item.id)).toMatchObject({ status: "queued", progress: 0 });
  });

  it("separates the queue from the history by status", () => {
    const queued = store.add(MD5, "Waiting");
    const done = store.add("108804c7a0e8c28c31071f2c34269570", "Done");
    store.update(done.id, { status: "downloaded" });

    expect(store.listActive().map((item) => item.id)).toEqual([queued.id]);
    expect(store.listHistory(10).map((item) => item.id)).toEqual([done.id]);
  });

  it("only cancels an item that has not started", () => {
    const queued = store.add(MD5, "Waiting");
    const running = store.add(MD5, "Running");
    store.update(running.id, { status: "downloading" });

    expect(store.cancel(queued.id)).toBe(true);
    expect(store.cancel(running.id)).toBe(false);
  });
});

describe("QueueService", () => {
  it("downloads a queued item and records the mirror that served it", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const mirrors = createMirrorService();
    const queue = new QueueService({ store, mirrors, outputDirectory: OUTPUT_DIRECTORY });
    const idle = waitForIdle(queue);
    queue.add(MD5, "A paper");
    await idle;

    const [item] = store.listHistory(10);
    expect(item).toMatchObject({
      status: "downloaded",
      filename: "book.epub",
      mirror: "https://first.example/",
      total: 18,
    });
    expect(mirrors.getState().preferredMirrorSource).toBe("https://first.example/");
  });

  it("records why an item failed instead of losing the reason", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const mirrors = createMirrorService();
    const queue = new QueueService({ store, mirrors, outputDirectory: OUTPUT_DIRECTORY });
    const idle = waitForIdle(queue);
    queue.add(MD5);
    await idle;

    const [item] = store.listHistory(10);
    expect(item.status).toBe("failed");
    expect(item.error).toBe("not found on any mirror (first.example)");
  });

  it("reports progress and terminal state to subscribers", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const mirrors = createMirrorService();
    const queue = new QueueService({ store, mirrors, outputDirectory: OUTPUT_DIRECTORY });
    const statuses: string[] = [];
    queue.subscribe((event) => {
      if (event.type !== "queue-idle") {
        statuses.push(event.item.status);
      }
    });

    const idle = waitForIdle(queue);
    queue.add(MD5);
    await idle;

    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("downloading");
    expect(statuses.at(-1)).toBe("downloaded");
  });

  it("leaves a cancelled item alone when the queue drains", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const mirrors = createMirrorService();
    const queue = new QueueService({ store, mirrors, outputDirectory: OUTPUT_DIRECTORY });

    const item: QueueItem = store.add(MD5, "Not wanted");
    expect(queue.cancel(item.id)).toBe(true);

    const idle = waitForIdle(queue);
    queue.start();
    await idle;

    expect(store.get(item.id)?.status).toBe("cancelled");
  });
});
