import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { libgenFileCooldownUntil, noteLibgenFileLimit } from "../src/api/data/libgen-file-pacing";
import { resolveDownloadURL } from "../src/api/data/resolve";
import { ItemStore } from "../src/server/database";
import { parseProxyList } from "../src/server/lane-service";
import { MirrorService } from "../src/server/mirror-service";
import { QueueService } from "../src/server/queue-service";
import { getRequestURL, mockFetch } from "./support/fetch-mock";
import { stubPartFileRename } from "./support/fs-mock";

const MD5S = [
  "b7abef3d085a1007a137a247dcff8dcb",
  "108804c7a0e8c28c31071f2c34269570",
  "0aed81639c2e9b609e83d67668bc2c60",
  "0db34f4676a91eceb556659b778b3a2d",
];

const LANES = [{ key: "main" }, { key: "DE-6", proxy: "http://172.30.0.11:8888" }];

let store: ItemStore;
const queues: QueueService[] = [];

const createMirrorService = () => {
  const service = new MirrorService();
  const mirror = { src: "https://first.example/", type: "libgen-plus" as const };
  service.use([mirror], mirror);
  return service;
};

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

/** Records which proxy each request went out through; "" for none. */
const mockLibgen = () => {
  const requests: { url: string; proxy: string }[] = [];
  mockFetch(async (input, init) => {
    const url = getRequestURL(input);
    requests.push({ url, proxy: (init as { proxy?: string } | undefined)?.proxy ?? "" });
    if (url.includes("/ads.php")) {
      const md5 = new URL(url).searchParams.get("md5");
      return new Response(
        `<table id="main"><tr><td>Book</td><td><a href="https://first.example/get.php?md5=${md5}">GET</a></td></tr></table>`
      );
    }

    return new Response("downloaded content", {
      headers: {
        "content-disposition": 'attachment; filename="paper.pdf"',
        "content-length": "18",
      },
    });
  });
  return requests;
};

const drain = (queue: QueueService) =>
  new Promise<void>((resolve) => {
    const unsubscribe = queue.subscribe((event) => {
      if (event.type === "queue-idle") {
        unsubscribe();
        resolve();
      }
    });
  });

describe("parseProxyList", () => {
  it("reads named and bare entries", () => {
    expect(parseProxyList(" DE-6=http://172.30.0.11:8888 , http://172.30.0.12:8888,")).toEqual([
      { key: "DE-6", proxy: "http://172.30.0.11:8888" },
      { key: "proxy-2", proxy: "http://172.30.0.12:8888" },
    ]);
    expect(parseProxyList("")).toEqual([]);
  });
});

describe("QueueService with several lanes", () => {
  it("spreads workers across lanes, each download's page and file on one lane", async () => {
    const requests = mockLibgen();
    const queue = new QueueService({
      store,
      mirrors: createMirrorService(),
      outputDirectory: path.join(os.tmpdir(), "libgen-downloader-lanes-test"),
      concurrency: 2,
      lanes: LANES,
    });
    queues.push(queue);
    const idle = drain(queue);
    for (const md5 of MD5S.slice(0, 2)) {
      queue.add({ md5 });
    }
    await idle;

    // Both lanes carried a download, and never mixed within one: the page's
    // key is issued to the address that fetched it.
    const proxiesByMD5 = new Map<string, Set<string>>();
    for (const request of requests) {
      const md5 = new URL(request.url).searchParams.get("md5") ?? "";
      proxiesByMD5.set(md5, (proxiesByMD5.get(md5) ?? new Set()).add(request.proxy));
    }
    expect([...proxiesByMD5.values()].map((proxies) => proxies.size)).toEqual([1, 1]);
    expect(new Set(requests.map((request) => request.proxy))).toEqual(
      new Set(["", "http://172.30.0.11:8888"])
    );
  });

  it("gives a lane that is down no work", async () => {
    const requests = mockLibgen();
    const queue = new QueueService({
      store,
      mirrors: createMirrorService(),
      outputDirectory: path.join(os.tmpdir(), "libgen-downloader-lanes-test"),
      concurrency: 2,
      lanes: LANES,
      isLaneReady: (lane) => lane.key === "main",
    });
    queues.push(queue);
    const idle = drain(queue);
    const items = MD5S.map((md5) => queue.add({ md5 }));
    await idle;

    expect(items.map((item) => store.get(item.id)?.status)).toEqual([
      "downloaded",
      "downloaded",
      "downloaded",
      "downloaded",
    ]);
    expect(requests.every((request) => request.proxy === "")).toBe(true);
  });
});

describe("LibGen file pacing per lane", () => {
  it("holds only the lane that was refused", () => {
    noteLibgenFileLimit(300_000, "FI-13");

    expect(libgenFileCooldownUntil("FI-13")).toBeGreaterThan(Date.now());
    expect(libgenFileCooldownUntil("DE-6")).toBe(0);
  });
});

describe("resolveDownloadURL through a proxy", () => {
  it("does not mark a mirror unreachable for every lane when one proxy fails", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const unreachable: string[] = [];

    const result = await resolveDownloadURL({
      md5: MD5S[0],
      candidates: [
        {
          mirror: { src: "https://first.example/", type: "libgen-plus" },
          adapter: new LibgenPlusAdapter("https://first.example/"),
        },
      ],
      onMirrorUnreachable: (mirror) => unreachable.push(mirror),
      proxy: "http://172.30.0.11:8888",
    });

    expect(result.status).toBe("unreachable");
    expect(unreachable).toEqual([]);
  });
});

describe("a lane LibGen stops answering through", () => {
  it("puts the item back for another lane and benches the lane", async () => {
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = getRequestURL(input);
      const proxy = (init as { proxy?: string } | undefined)?.proxy ?? "";
      requests.push(proxy);
      // LibGen refuses the proxied exit IP outright.
      if (proxy) {
        return new Response("<h1>503. Service Temporarily Unavailable</h1>", { status: 503 });
      }
      if (url.includes("/ads.php")) {
        return new Response(
          '<table id="main"><tr><td>Book</td><td><a href="https://first.example/get.php?md5=x">GET</a></td></tr></table>'
        );
      }
      return new Response("downloaded content", {
        headers: {
          "content-disposition": 'attachment; filename="paper.pdf"',
          "content-length": "18",
        },
      });
    });

    const benched: string[] = [];
    const finished: string[] = [];
    const queue = new QueueService({
      store,
      mirrors: createMirrorService(),
      outputDirectory: path.join(os.tmpdir(), "libgen-downloader-lanes-test"),
      concurrency: 1,
      // The proxied lane first, so the item is sure to be handed to it.
      lanes: [LANES[1], LANES[0]],
      isLaneReady: (lane) => !benched.includes(lane.key),
      onLaneTrouble: (lane) => benched.push(lane.key),
      onFinished: (item) => finished.push(item.status),
    });
    queues.push(queue);
    const idle = drain(queue);
    const item = queue.add({ md5: MD5S[0] });
    await idle;
    // The benched worker handed its slot back; the retry timer would restart
    // it. Here the test does.
    const again = drain(queue);
    queue.start();
    await again;

    expect(benched).toEqual(["DE-6"]);
    expect(store.get(item.id)?.status).toBe("downloaded");
    // Told once, when it really finished - not when it went back in the queue.
    expect(finished).toEqual(["downloaded"]);
  });
});

describe("DOI lookups on the worker's lane", () => {
  it("hands each lookup the lane of the worker doing it", async () => {
    mockLibgen();
    const lanesAsked: string[] = [];
    const queue = new QueueService({
      store,
      mirrors: createMirrorService(),
      outputDirectory: path.join(os.tmpdir(), "libgen-downloader-lanes-test"),
      concurrency: 2,
      lanes: LANES,
      resolveDOI: async (_doi, lane) => {
        lanesAsked.push(lane?.key ?? "none");
        return { md5: MD5S[lanesAsked.length - 1], source: "libgen" };
      },
    });
    queues.push(queue);
    const idle = drain(queue);
    queue.add({ doi: "10.1145/1", origin: "list" });
    queue.add({ doi: "10.1145/2", origin: "list" });
    await idle;

    expect(new Set(lanesAsked)).toEqual(new Set(["main", "DE-6"]));
  });
});

describe("Sci-Hub on a lane", () => {
  it("asks through the lane's proxy, and a captcha holds back only that lane", async () => {
    const { scihubSource, scihubCooldownUntil, resetScihubPacing } =
      await import("../src/api/sources/scihub");
    resetScihubPacing();
    process.env.LIBGEN_SCIHUB_HOSTS = "sci-hub.example";
    const proxies: string[] = [];
    mockFetch(async (_input, init) => {
      proxies.push((init as { proxy?: string } | undefined)?.proxy ?? "");
      // No citation_pdf_url: the captcha page.
      return new Response("<html><title>Sci-Hub</title>altcha</html>");
    });

    await scihubSource.search({ kind: "doi", doi: "10.1145/1" }, 1, {
      candidates: [],
      proxy: "http://172.30.0.11:8888",
    });
    delete process.env.LIBGEN_SCIHUB_HOSTS;

    expect(proxies).toEqual(["http://172.30.0.11:8888"]);
    expect(scihubCooldownUntil("http://172.30.0.11:8888")).toBeGreaterThan(Date.now());
    expect(scihubCooldownUntil()).toBe(0);
    resetScihubPacing();
  });
});
