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
import { stubPartFileRename } from "./support/fs-mock";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";
const OTHER_MD5 = "108804c7a0e8c28c31071f2c34269570";
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

/**
 * A queue that takes nothing: its output disk lacks the marker, which holds
 * every item - unlike having no mirror, which still lets a URL row through.
 * For tests that inspect rows as they were queued.
 */
const createPausedQueue = () =>
  createQueue({ storage: new StorageService({ directory: OUTPUT_DIRECTORY, marker: MARKER }) });

beforeEach(() => {
  store = new ItemStore(":memory:");
  // Tests share one output directory, and a run killed mid-test would
  // otherwise leave a marker behind that silently flips the next run's
  // storage checks from "unplugged" to "ready".
  fs.rmSync(path.join(OUTPUT_DIRECTORY, MARKER), { force: true });
  stubPartFileRename();
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
    const item = store.add({ md5: MD5, title: "Interrupted" });
    store.update(item.id, { status: "downloading", progress: 500 });

    const recovered = store.recoverInterrupted();

    expect(recovered).toBe(1);
    expect(store.get(item.id)).toMatchObject({ status: "queued", progress: 0 });
  });

  it("separates the queue from the history by status", () => {
    const queued = store.add({ md5: MD5, title: "Waiting" });
    const done = store.add({ md5: "108804c7a0e8c28c31071f2c34269570", title: "Done" });
    store.update(done.id, { status: "downloaded" });

    expect(store.listActive().map((item) => item.id)).toEqual([queued.id]);
    expect(store.listHistory(10).map((item) => item.id)).toEqual([done.id]);
  });

  it("only cancels an item that has not started", () => {
    const queued = store.add({ md5: MD5, title: "Waiting" });
    const running = store.add({ md5: MD5, title: "Running" });
    store.update(running.id, { status: "downloading" });

    expect(store.cancel(queued.id)).toBe(true);
    expect(store.cancel(running.id)).toBe(false);
  });

  it("removes a dismissed failure from the history entirely", () => {
    // Marking it cancelled instead kept it in the history and, by touching
    // updated_at, moved it to the top - above whatever fetched the paper since.
    const abandoned = store.add({ md5: MD5, title: "Not worth retrying" });
    const wanted = store.add({ md5: OTHER_MD5, title: "Still wanted" });
    store.update(abandoned.id, { status: "failed" });
    store.update(wanted.id, { status: "failed" });

    expect(store.dismiss(abandoned.id)).toBe(true);
    expect(store.get(abandoned.id)).toBeUndefined();
    expect(store.listFailed().map((item) => item.id)).toEqual([wanted.id]);
    expect(store.listHistory(10).map((item) => item.id)).toEqual([wanted.id]);
  });

  it("requeues a failure as the same row, with its outcome cleared", () => {
    const item = store.add({ md5: MD5, title: "Try again" });
    store.update(item.id, { status: "failed", error: "HTTP 500", progress: 20, total: 40 });

    expect(store.requeue(item.id)).toBe(true);
    expect(store.get(item.id)).toMatchObject({ status: "queued", error: "", progress: 0 });
    expect(store.listActive().map((active) => active.id)).toEqual([item.id]);
    expect(store.listHistory(10)).toHaveLength(0);
  });

  it("will not requeue something that downloaded", () => {
    const item = store.add({ md5: MD5 });
    store.update(item.id, { status: "downloaded" });

    expect(store.requeue(item.id)).toBe(false);
    expect(store.get(item.id)?.status).toBe("downloaded");
  });

  it("clears failures superseded by a download or by a later failure", () => {
    const failedFirst = store.add({ md5: MD5 });
    const cancelled = store.add({ md5: MD5 });
    const fetched = store.add({ md5: MD5 });
    store.update(failedFirst.id, { status: "failed" });
    store.update(cancelled.id, { status: "cancelled" });
    store.update(fetched.id, { status: "downloaded" });

    const repeats = [1, 2, 3].map(() => store.add({ md5: OTHER_MD5 }));
    for (const repeat of repeats) {
      store.update(repeat.id, { status: "failed" });
    }

    const lone = store.add({ source: "scihub", url: "https://sci-hub.example/paper.pdf" });
    store.update(lone.id, { status: "failed" });

    expect(store.collapseSuperseded()).toBe(4);
    expect(store.listHistory(10).map((item) => item.id)).toEqual(
      expect.arrayContaining([fetched.id, repeats[2].id, lone.id])
    );
    expect(store.listHistory(10)).toHaveLength(3);
    expect(store.collapseSuperseded()).toBe(0);
  });

  it("will not dismiss anything that has not failed", () => {
    const queued = store.add({ md5: MD5, title: "Waiting" });

    expect(store.dismiss(queued.id)).toBe(false);
    expect(store.get(queued.id)?.status).toBe("queued");
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
    queue.add({ md5: MD5, title: "A paper" });
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
    queue.add({ md5: MD5 });
    await idle;

    expect(store.listHistory(10)[0]?.filename).toBe("book.epub");
  });

  it("records why an item failed instead of losing the reason", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const mirrors = createMirrorService();
    const queue = createQueue({ mirrors });
    const idle = waitForIdle(queue);
    queue.add({ md5: MD5 });
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
      if (event.type === "item-added" || event.type === "item-updated") {
        statuses.push(event.item.status);
      }
    });

    const idle = waitForIdle(queue);
    queue.add({ md5: MD5 });
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
    const item = queue.add({ md5: MD5, title: "Waiting for the tunnel" });
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
    const item = queue.add({ md5: MD5, title: "Waiting for the disk" });
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
      queue.add({ md5: MD5, title: "A paper" });
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
      const item = queue.add({ md5: MD5, title: "Waiting for the disk" });
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
    queue.add({ md5: MD5, title: "A paper" });
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
    const item = queue.add({ md5: MD5 });
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

    const item: QueueItem = store.add({ md5: MD5, title: "Not wanted" });
    expect(queue.cancel(item.id)).toBe(true);

    const idle = waitForIdle(queue);
    queue.start();
    await idle;

    expect(store.get(item.id)?.status).toBe("cancelled");
  });
});

describe("QueueService keeps one row per file", () => {
  it("retries a failure in place rather than adding a row", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const failed = store.add({ md5: MD5, title: "A paper" });
    store.update(failed.id, { status: "failed", error: "HTTP 500" });

    const queue = createQueue();
    const idle = waitForIdle(queue);
    expect(queue.retry(failed.id)).toBe(true);
    await idle;

    const history = store.listHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: failed.id, status: "downloaded", error: "" });
  });

  it("puts a failed file back in the queue when it is queued again", () => {
    const queue = createPausedQueue();
    const failed = store.add({ md5: MD5 });
    store.update(failed.id, { status: "failed" });

    const requeued = queue.add({ md5: MD5, title: "Found by DOI", doi: "10.1145/1" });

    expect(requeued).toMatchObject({ id: failed.id, status: "queued" });
    expect(requeued).toMatchObject({ title: "Found by DOI", doi: "10.1145/1" });
    expect(store.listHistory(10)).toHaveLength(0);
  });

  it("does not queue a file twice while it is waiting", () => {
    const queue = createPausedQueue();
    const first = queue.add({ md5: MD5 });
    const second = queue.add({ md5: MD5 });
    const byURL = queue.add({ source: "arxiv", url: "https://arxiv.example/1.pdf" });
    const byURLAgain = queue.add({ source: "arxiv", url: "https://arxiv.example/1.pdf" });

    expect(second.id).toBe(first.id);
    expect(byURLAgain.id).toBe(byURL.id);
    expect(store.listActive()).toHaveLength(2);
  });

  it("queues a downloaded file afresh, leaving the disk to say it is there", () => {
    const queue = createPausedQueue();
    const downloaded = store.add({ md5: MD5 });
    store.update(downloaded.id, { status: "downloaded" });

    const again = queue.add({ md5: MD5 });

    expect(again.id).not.toBe(downloaded.id);
    expect(store.get(downloaded.id)?.status).toBe("downloaded");
  });
});

describe("QueueService with an item queued by DOI alone", () => {
  const DOI = "10.1145/1073204.1073206";

  it("looks the DOI up when its turn comes, then downloads what it found", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const lookedUp: string[] = [];
    const queue = createQueue({
      resolveDOI: async (doi) => {
        lookedUp.push(doi);
        return { md5: MD5, source: "libgen", title: "Found by DOI" };
      },
    });
    const idle = waitForIdle(queue);
    const item = queue.add({ doi: DOI });
    await idle;

    expect(lookedUp).toEqual([DOI]);
    expect(store.get(item.id)).toMatchObject({
      status: "downloaded",
      md5: MD5,
      doi: DOI,
      title: "Found by DOI",
    });
  });

  it("fails the row with the lookup's reason when no source has it", async () => {
    const queue = createQueue({
      resolveDOI: async (doi) => ({ reason: `no file on any source for ${doi}` }),
    });
    const idle = waitForIdle(queue);
    const item = queue.add({ doi: DOI });
    await idle;

    expect(store.get(item.id)).toMatchObject({
      status: "failed",
      error: `no file on any source for ${DOI}`,
    });
  });

  it("names the file by the DOI's registered title once it has been looked up", async () => {
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return fileResponse();
    });

    const queue = createQueue({
      resolveDOI: async () => ({ md5: MD5, source: "libgen", title: "CATALOGUE ENTRY" }),
    });
    const item = store.add({ doi: DOI, origin: "list" });
    store.setMetadata(item.id, { status: "found", title: "Skinning mesh animations" });
    const idle = waitForIdle(queue);
    queue.start();
    await idle;

    expect(store.get(item.id)).toMatchObject({
      status: "downloaded",
      title: "Skinning mesh animations",
      origin: "list",
    });
  });

  it("does not queue one DOI twice, whatever its case", () => {
    const queue = createPausedQueue();
    const first = queue.add({ doi: DOI });
    const second = queue.add({ doi: DOI.toUpperCase() });

    expect(second.id).toBe(first.id);
    expect(store.listActive()).toHaveLength(1);
  });
});

describe("QueueService with a direct URL", () => {
  it("fetches the URL instead of resolving an md5", async () => {
    const fetchMock = mockFetch(async () => fileResponse());

    const queue = createQueue();
    const idle = waitForIdle(queue);
    queue.add({
      source: "arxiv",
      url: "https://arxiv.org/pdf/2304.00359v1",
      title: "A preprint",
    });
    await idle;

    // No detail page walked: a URL is already a location.
    expect(fetchMock.requestedURLs).toEqual(["https://arxiv.org/pdf/2304.00359v1"]);
    const [item] = store.listHistory(10);
    expect(item).toMatchObject({
      status: "downloaded",
      source: "arxiv",
      filename: "A preprint.epub",
      total: 18,
    });
  });

  it("downloads even with no mirror, which it has no need of", async () => {
    // An arXiv row has no reason to wait on LibGen being reachable - and
    // before sources existed, the missing-mirror guard paused the whole queue
    // for every item alike.
    mockFetch(async () => fileResponse());

    const queue = createQueue({ mirrors: new MirrorService() });
    const idle = waitForIdle(queue);
    const item = queue.add({ source: "arxiv", url: "https://arxiv.org/pdf/2304.00359v1" });
    await idle;

    expect(store.get(item.id)?.status).toBe("downloaded");
  });

  it("records the source rather than a mirror that never served it", async () => {
    mockFetch(async () => fileResponse());

    const queue = createQueue();
    const idle = waitForIdle(queue);
    const item = queue.add({ source: "scihub", url: "https://sci-hub.red/storage/a/b.pdf" });
    await idle;

    // The `mirror` column answers "where did this come from", and for a direct
    // download the honest answer is the source, not a LibGen host.
    expect(store.get(item.id)?.mirror).toBe("scihub");
  });

  it("writes the DOI into the filename, which keeps a Sci-Hub result identifiable", async () => {
    mockFetch(async () => new Response("%PDF-1.4", { headers: { "content-length": "8" } }));

    const queue = createQueue();
    const idle = waitForIdle(queue);
    const item = queue.add({
      source: "scihub",
      url: "https://sci-hub.red/storage/twin/6684/abc/lorensen1987.pdf",
      title: "Marching cubes",
      doi: "10.1145/37402.37422",
    });
    await idle;

    expect(store.get(item.id)?.filename).toBe("Marching cubes [10.1145_37402.37422].pdf");
  });

  it("treats an item queued before sources existed as LibGen's", async () => {
    // The `source` column was added by ALTER TABLE, so every existing row
    // reads back NULL and must not become an unroutable item.
    const item = store.add({ md5: MD5, title: "Queued last week" });

    expect(item.source).toBe("libgen");
    expect(item.url).toBe("");
  });
});

describe("QueueService working on several items at once", () => {
  it("runs up to its concurrency together, each row taken once", async () => {
    // Every file request is held open until the test releases it, so the only
    // way three can be in flight together is three workers.
    const released: (() => void)[] = [];
    const fileRequests: string[] = [];
    mockFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/ads.php")) {
        const md5 = new URL(url).searchParams.get("md5");
        return new Response(
          `<table id="main"><tr><td>Book</td><td><a href="https://first.example/files/${md5}.epub">GET</a></td></tr></table>`
        );
      }

      fileRequests.push(url);
      await new Promise<void>((resolve) => released.push(resolve));
      return fileResponse();
    });

    const md5s = [
      MD5,
      OTHER_MD5,
      "0aed81639c2e9b609e83d67668bc2c60",
      "0db34f4676a91eceb556659b778b3a2d",
    ];
    const queue = createQueue({ concurrency: 3 });
    const idle = waitForIdle(queue);
    const items = md5s.map((md5) => queue.add({ md5 }));

    const deadline = Date.now() + 5000;
    while (fileRequests.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Three at once, and the fourth still waiting for a free worker.
    expect(fileRequests).toHaveLength(3);
    expect(new Set(fileRequests).size).toBe(3);
    expect(store.get(items[3].id)?.status).toBe("queued");

    // Let everything through, including the fourth once a worker frees up.
    const releaseAll = setInterval(() => {
      for (const release of released.splice(0)) {
        release();
      }
    }, 5);
    await idle;
    clearInterval(releaseAll);

    expect(items.map((item) => store.get(item.id)?.status)).toEqual([
      "downloaded",
      "downloaded",
      "downloaded",
      "downloaded",
    ]);
    expect(fileRequests).toHaveLength(4);
  });

  it("still fetches what carries its own URL while no mirror is reachable", async () => {
    mockFetch(async () => fileResponse());

    const queue = createQueue({ mirrors: new MirrorService(), concurrency: 2 });
    const idle = waitForIdle(queue);
    const needsMirror = queue.add({ md5: MD5, title: "Waiting for the tunnel" });
    const direct = queue.add({ source: "arxiv", url: "https://arxiv.example/1.pdf" });
    await idle;

    expect(store.get(needsMirror.id)?.status).toBe("queued");
    expect(store.get(direct.id)?.status).toBe("downloaded");
  });

  it("never hands one row to two workers", () => {
    const first = store.add({ md5: MD5 });
    const second = store.add({ md5: OTHER_MD5 });

    expect(store.claimNext()?.id).toBe(first.id);
    expect(store.claimNext()?.id).toBe(second.id);
    expect(store.claimNext()).toBeUndefined();
    expect(store.get(first.id)?.status).toBe("resolving");
  });
});

describe("deferring transient failures", () => {
  it("keeps a deferred row from every worker until its time comes", () => {
    const item = store.add({ md5: MD5 });
    const updatedBefore = store.get(item.id)?.updatedAt;

    store.defer(item.id, 3_600_000, "LibGen's server is overloaded - trying again later");

    expect(store.get(item.id)).toMatchObject({ status: "queued", deferrals: 1 });
    expect(store.get(item.id)?.retryAt).not.toBe("");
    expect(store.get(item.id)?.updatedAt).toBe(updatedBefore);
    expect(store.claimNext()).toBeUndefined();

    // Its time has come: a zero delay puts it at "now".
    store.defer(item.id, 0, "again");
    expect(store.claimNext()?.id).toBe(item.id);
  });

  it("clears the wait when retried by hand", () => {
    const item = store.add({ md5: MD5 });
    store.defer(item.id, 3_600_000, "waiting");
    store.update(item.id, { status: "failed" });

    expect(store.requeue(item.id)).toBe(true);
    expect(store.get(item.id)).toMatchObject({ retryAt: "", deferrals: 0 });
    expect(store.claimNext()?.id).toBe(item.id);
  });

  it("defers an overloaded server instead of failing, then fails once the waits run out", async () => {
    // Each pass runs a transfer's six attempts; their backoff is real seconds,
    // so `delay` is stubbed to return at once, as the download tests do.
    const utilities = await import("../src/utilities");
    mock.module("../src/utilities", () => ({ ...utilities, delay: async () => {} }));

    // Every file request answered with a bad gateway, as LibGen's server did
    // for hours on 24 September.
    mockFetch(async (input) => {
      if (input.toString().includes("/ads.php")) {
        return new Response(detailPage);
      }

      return new Response("<h1>Internal Server Error</h1>", { status: 502 });
    });

    const queue = createQueue({ deferScheduleMs: [0, 0] });
    const item = store.add({ md5: MD5, title: "Busy" });

    // Three passes: two deferrals, then the schedule is spent.
    for (let pass = 0; pass < 3; pass++) {
      const idle = waitForIdle(queue);
      queue.start();
      await idle;
    }

    expect(store.get(item.id)).toMatchObject({ status: "failed", deferrals: 2 });
    expect(store.get(item.id)?.error).toContain("still failing after being retried");
  });

  it("fails a file every mirror says it has no record of, at once", async () => {
    mockFetch(async () => new Response("<html>no record</html>"));

    const queue = createQueue({ deferScheduleMs: [0, 0] });
    const idle = waitForIdle(queue);
    const item = queue.add({ md5: MD5 });
    await idle;

    expect(store.get(item.id)).toMatchObject({ status: "failed", deferrals: 0 });
  });

  it("defers a DOI lookup that could not be completed", async () => {
    const queue = createQueue({
      deferScheduleMs: [3_600_000],
      resolveDOI: async () => ({
        reason: "nothing found yet - Sci-Hub asked for a captcha",
        transient: true,
      }),
    });
    const idle = waitForIdle(queue);
    const item = queue.add({ doi: "10.1145/1" });
    await idle;

    expect(store.get(item.id)).toMatchObject({ status: "queued", deferrals: 1 });
    expect(store.get(item.id)?.error).toContain("trying again later");
  });
});

describe("Anna's Archive as a second way to a LibGen file", () => {
  it("fetches by MD5 from Anna's when LibGen answers that it has no record", async () => {
    const asked: string[] = [];
    mockFetch(async (input) => {
      const url = input.toString();
      asked.push(url);
      if (url.includes("/dyn/api/fast_download.json")) {
        return Response.json({
          download_url: "https://fast.example/file.epub",
          account_fast_download_info: { downloads_left: 9 },
        });
      }
      if (url === "https://fast.example/file.epub") {
        return fileResponse();
      }
      // Every LibGen mirror: no record.
      return new Response("<html>no record</html>");
    });

    const queue = createQueue({ annasKey: "secret", annasDomain: "annas.example" });
    const idle = waitForIdle(queue);
    const item = queue.add({ md5: MD5, title: "Rescued" });
    await idle;

    expect(store.get(item.id)).toMatchObject({
      status: "downloaded",
      mirror: "https://annas.example/",
    });
    expect(asked.some((url) => url.includes("md5=" + MD5) && url.includes("key=secret"))).toBe(
      true
    );
  });

  it("stops asking for the rest of the day once the key can fetch nothing", async () => {
    let apiCalls = 0;
    mockFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/dyn/api/fast_download.json")) {
        apiCalls += 1;
        return Response.json({ error: "Invalid secret key" }, { status: 401 });
      }
      return new Response("<html>no record</html>");
    });

    const queue = createQueue({ annasKey: "wrong", annasDomain: "annas.example" });
    const idle = waitForIdle(queue);
    queue.add({ md5: MD5 });
    queue.add({ md5: OTHER_MD5 });
    await idle;

    expect(apiCalls).toBe(1);
  });

  it("is off without a key", async () => {
    const asked: string[] = [];
    mockFetch(async (input) => {
      asked.push(input.toString());
      return new Response("<html>no record</html>");
    });

    const queue = createQueue();
    const idle = waitForIdle(queue);
    queue.add({ md5: MD5 });
    await idle;

    expect(asked.some((url) => url.includes("fast_download"))).toBe(false);
  });
});

describe("a page where the file should be", () => {
  it("fails a URL download that serves HTML rather than saving it as the file", async () => {
    mockFetch(
      async () =>
        new Response("<html><title>Making sure you're not a bot!</title></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
    );

    const queue = createQueue();
    const idle = waitForIdle(queue);
    const item = queue.add({ source: "openaccess", url: "https://repo.example/paper.pdf" });
    await idle;

    expect(store.get(item.id)).toMatchObject({ status: "failed" });
    expect(store.get(item.id)?.error).toContain("sent a page instead of the file");
  });
});
