import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import { Writable } from "node:stream";
import { ItemStore } from "../src/server/database";
import { MirrorService } from "../src/server/mirror-service";
import { QueueService } from "../src/server/queue-service";
import { mockFetch } from "./support/fetch-mock";
import { stubPartFileRename } from "./support/fs-mock";

const MD5S = [
  "b7abef3d085a1007a137a247dcff8dcb",
  "108804c7a0e8c28c31071f2c34269570",
  "0aed81639c2e9b609e83d67668bc2c60",
  "0db34f4676a91eceb556659b778b3a2d",
  "1db34f4676a91eceb556659b778b3a2d",
];

let store: ItemStore;
const queues: QueueService[] = [];

const createQueue = (options: Partial<ConstructorParameters<typeof QueueService>[0]> = {}) => {
  const mirrors = new MirrorService();
  const mirror = { src: "https://first.example/", type: "libgen-plus" as const };
  mirrors.use([mirror], mirror);
  const queue = new QueueService({
    store,
    mirrors,
    outputDirectory: "/tmp/queue-controls",
    ...options,
  });
  queues.push(queue);
  return queue;
};

/** File requests are held until released, so in-flight work can be counted. */
const holdFiles = () => {
  const held: (() => void)[] = [];
  let started = 0;
  mockFetch(async (input) => {
    const url = input.toString();
    if (url.includes("/ads.php")) {
      const md5 = new URL(url).searchParams.get("md5");
      return new Response(
        `<table id="main"><tr><td>Book</td><td><a href="https://first.example/files/${md5}.epub">GET</a></td></tr></table>`
      );
    }
    started += 1;
    await new Promise<void>((resolve) => held.push(resolve));
    return new Response("downloaded content", {
      headers: { "content-disposition": 'attachment; filename="b.epub"', "content-length": "18" },
    });
  });
  return {
    inFlight: () => held.length,
    started: () => started,
    releaseOne: () => held.shift()?.(),
  };
};

const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  store = new ItemStore(":memory:");
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

describe("queue controls", () => {
  it("takes nothing while paused, and carries on when resumed", async () => {
    const files = holdFiles();
    const queue = createQueue({ concurrency: 2 });
    queue.setPaused(true);
    const item = queue.add({ md5: MD5S[0] });

    await settle();
    expect(store.get(item.id)?.status).toBe("queued");
    expect(queue.isPaused()).toBe(true);

    queue.setPaused(false);
    await until(() => files.inFlight() === 1);
    files.releaseOne();
    await until(() => store.get(item.id)?.status === "downloaded");
  });

  it("lets what is already downloading finish when paused", async () => {
    const files = holdFiles();
    const queue = createQueue({ concurrency: 1 });
    const first = queue.add({ md5: MD5S[0] });
    const second = queue.add({ md5: MD5S[1] });
    await until(() => files.inFlight() === 1);

    queue.setPaused(true);
    files.releaseOne();
    await until(() => store.get(first.id)?.status === "downloaded");
    await settle();
    expect(store.get(second.id)?.status).toBe("queued");
  });

  it("takes on more at once as soon as the concurrency is raised", async () => {
    const files = holdFiles();
    const queue = createQueue({ concurrency: 1 });
    for (const md5 of MD5S.slice(0, 4)) {
      queue.add({ md5 });
    }
    await until(() => files.inFlight() === 1);

    queue.setConcurrency(3);
    expect(queue.getConcurrency()).toBe(3);
    await until(() => files.inFlight() === 3);
  });

  it("winds down to a lowered concurrency as downloads finish", async () => {
    const files = holdFiles();
    const queue = createQueue({ concurrency: 3 });
    for (const md5 of MD5S) {
      queue.add({ md5 });
    }
    await until(() => files.inFlight() === 3);

    queue.setConcurrency(1);
    files.releaseOne();
    files.releaseOne();
    await settle();
    // Two finished; their workers retired rather than taking more.
    expect(files.inFlight()).toBe(1);
    expect(files.started()).toBe(3);
    files.releaseOne();
    await until(() => files.started() === 4);
    expect(files.inFlight()).toBe(1);
  });

  it("counts what each lane downloaded since the start", async () => {
    mockFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/ads.php")) {
        return new Response(
          '<table id="main"><tr><td>Book</td><td><a href="https://first.example/files/x.epub">GET</a></td></tr></table>'
        );
      }
      return new Response("downloaded content", {
        headers: { "content-disposition": 'attachment; filename="b.epub"', "content-length": "18" },
      });
    });
    const queue = createQueue({ concurrency: 1, lanes: [{ key: "FI-1" }] });
    const item = queue.add({ md5: MD5S[0] });
    await until(() => store.get(item.id)?.status === "downloaded");

    expect(queue.laneStats()["FI-1"]).toMatchObject({
      workers: 0,
      downloaded: 1,
      failed: 0,
      bytes: 18,
    });
  });
});

describe("ItemStore stats", () => {
  it("counts the queue by status and what finished recently", () => {
    const done = store.add({ md5: MD5S[0] });
    store.update(done.id, { status: "downloaded", total: 1000, mirror: "https://first.example/" });
    const failed = store.add({ md5: MD5S[1] });
    store.update(failed.id, { status: "failed" });
    store.add({ md5: MD5S[2] });

    const stats = store.stats();
    expect(stats.byStatus).toMatchObject({ downloaded: 1, failed: 1, queued: 1 });
    expect(stats.lastDay).toMatchObject({ downloaded: 1, failed: 1, bytes: 1000 });
    expect(stats.lastHour.downloaded).toBe(1);
    expect(stats.lastDay.bySource).toEqual({ "https://first.example/": 1 });
  });
});
