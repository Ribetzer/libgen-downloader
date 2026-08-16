import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ItemStore, QueueItem } from "../src/server/database";
import { MirrorService } from "../src/server/mirror-service";
import { QueueService } from "../src/server/queue-service";
import { StorageService } from "../src/server/storage-service";
import { mockFetch } from "./support/fetch-mock";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";
const OUTPUT_DIRECTORY = path.join(os.tmpdir(), "libgen-downloader-queue-test");
const MARKER = ".libgen-volume";

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

/**
 * Polls the store until an item reaches `status`. A paused queue emits
 * `queue-idle` on every retry, so "wait for the next idle" resolves while the
 * queue is still paused - this waits for the outcome instead of a signal.
 */
const waitForStatus = async (id: number, status: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (store.get(id)?.status === status) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`item ${id} never reached "${status}" (last: ${store.get(id)?.status})`);
};

let store: ItemStore;

/**
 * Every queue built by a test, so `afterEach` can stop its retry timer. A queue
 * that paused for a missing mirror or disk re-arms that timer each time it
 * fires, which keeps the test process alive indefinitely once the tests
 * themselves have finished.
 */
const queues: QueueService[] = [];

const createQueue = (options: Partial<ConstructorParameters<typeof QueueService>[0]> = {}) => {
  const queue = new QueueService({
    store,
    mirrors: createMirrorService(),
    outputDirectory: OUTPUT_DIRECTORY,
    ...options,
  });
  queues.push(queue);
  return queue;
};

beforeEach(() => {
  store = new ItemStore(":memory:");
  // Tests share one output directory, and a run killed mid-test would
  // otherwise leave a marker behind that silently flips the next run's
  // storage checks from "unplugged" to "ready".
  fs.rmSync(path.join(OUTPUT_DIRECTORY, MARKER), { force: true });
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
  for (const queue of queues.splice(0)) {
    queue.dispose();
  }
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
    const queue = createQueue({ mirrors });
    const idle = waitForIdle(queue);
    queue.add(MD5, "A paper");
    await idle;

    const [item] = store.listHistory(10);
    expect(item).toMatchObject({
      status: "downloaded",
      // Named from the queued title, not the mirror's "book.epub": whoever
      // queued it knows the real title, and libgen's own name often does not.
      filename: "A paper.epub",
      mirror: "https://first.example/",
      total: 18,
    });
    expect(mirrors.getState().preferredMirrorSource).toBe("https://first.example/");
  });

  it("falls back to the mirror's filename when queued without a title", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const queue = createQueue();
    const idle = waitForIdle(queue);
    queue.add(MD5);
    await idle;

    expect(store.listHistory(10)[0]?.filename).toBe("book.epub");
  });

  it("records why an item failed instead of losing the reason", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const mirrors = createMirrorService();
    const queue = createQueue({ mirrors });
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
    const queue = createQueue({ mirrors });
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

  it("leaves items queued when no mirror is available yet", async () => {
    const fetchMock = mockFetch(async () => new Response("should not be called"));

    // A server that has not reached a mirror yet, as when the VPN is still
    // connecting.
    const mirrors = new MirrorService();
    const queue = createQueue({ mirrors });

    const idle = waitForIdle(queue);
    const item = queue.add(MD5, "Waiting for the tunnel");
    await idle;

    expect(store.get(item.id)?.status).toBe("queued");
    expect(fetchMock.requestedURLs).toEqual([]);
  });

  it("leaves items queued when the output volume is not the expected disk", async () => {
    const fetchMock = mockFetch(async () => new Response("should not be called"));

    // A directory that exists and is writable but carries no marker - exactly
    // what a phantom bind mount of an unplugged disk looks like.
    const storage = new StorageService({ directory: OUTPUT_DIRECTORY, marker: ".libgen-volume" });
    const queue = createQueue({
      storage,
    });

    const idle = waitForIdle(queue);
    const item = queue.add(MD5, "Waiting for the disk");
    await idle;

    expect(store.get(item.id)?.status).toBe("queued");
    expect(fetchMock.requestedURLs).toEqual([]);
  });

  it("downloads once the volume marker is there", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const markerPath = path.join(OUTPUT_DIRECTORY, MARKER);
    fs.writeFileSync(markerPath, "test-volume");

    try {
      const storage = new StorageService({ directory: OUTPUT_DIRECTORY, marker: MARKER });
      const queue = createQueue({
        storage,
      });

      const idle = waitForIdle(queue);
      queue.add(MD5, "A paper");
      await idle;

      expect(store.listHistory(10)[0]?.status).toBe("downloaded");
    } finally {
      fs.rmSync(markerPath, { force: true });
    }
  });

  it("picks the work back up once the volume returns, with no restart", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const markerPath = path.join(OUTPUT_DIRECTORY, MARKER);
    fs.rmSync(markerPath, { force: true });

    const storage = new StorageService({ directory: OUTPUT_DIRECTORY, marker: MARKER });
    const queue = createQueue({
      storage,
      retryMs: 25,
    });

    try {
      const pausedIdle = waitForIdle(queue);
      const item = queue.add(MD5, "Waiting for the disk");
      await pausedIdle;
      expect(store.get(item.id)?.status).toBe("queued");

      // Plug it back in. Nobody calls start() - the queue's own retry must.
      fs.writeFileSync(markerPath, "test-volume");
      storage.forget();

      await waitForStatus(item.id, "downloaded");
    } finally {
      queue.dispose();
      fs.rmSync(markerPath, { force: true });
    }
  });

  it("tells a listener about every finished item, whatever the outcome", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const finished: { md5: string; status: string }[] = [];
    const queue = createQueue({
      onFinished: (item) => finished.push({ md5: item.md5, status: item.status }),
    });

    const idle = waitForIdle(queue);
    queue.add(MD5, "A paper");
    await idle;

    expect(finished).toEqual([{ md5: MD5, status: "downloaded" }]);
  });

  it("keeps draining when a listener throws", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const queue = createQueue({
      onFinished: () => {
        throw new Error("webhook is down");
      },
    });

    const idle = waitForIdle(queue);
    const item = queue.add(MD5);
    await idle;

    // The failure is recorded rather than lost to the listener's exception.
    expect(store.get(item.id)?.status).toBe("failed");
  });

  it("leaves a cancelled item alone when the queue drains", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const mirrors = createMirrorService();
    const queue = createQueue({ mirrors });

    const item: QueueItem = store.add(MD5, "Not wanted");
    expect(queue.cancel(item.id)).toBe(true);

    const idle = waitForIdle(queue);
    queue.start();
    await idle;

    expect(store.get(item.id)?.status).toBe("cancelled");
  });
});
