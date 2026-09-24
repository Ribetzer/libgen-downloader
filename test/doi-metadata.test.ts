import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildCrossrefBatchURL,
  isBatchableDOI,
  parseCrossrefWorks,
  parseCSL,
} from "../src/api/data/doi-metadata";
import { ItemStore, QueueItem } from "../src/server/database";
import { MetadataService } from "../src/server/metadata-service";
import { getRequestURL, mockFetch } from "./support/fetch-mock";

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8"));

describe("parseCrossrefWorks", () => {
  it("reads a real batch answer, keyed by lower-cased DOI", () => {
    const found = parseCrossrefWorks(fixture("crossref-works-batch.json"));

    // Five DOIs were asked for; the Zenodo one is DataCite's and the other is
    // not registered at all, so Crossref answers three.
    expect(found.size).toBe(3);
    expect([...found.keys()]).toEqual(
      expect.arrayContaining([
        "10.1109/tg.2024.3497601",
        "10.1111/cgf.12271",
        "10.1145/1073204.1073206",
      ])
    );
    expect(found.get("10.1145/1073204.1073206")).toMatchObject({
      status: "found",
      title: "Skinning mesh animations",
      year: 2005,
      venue: "ACM Transactions on Graphics",
      source: "crossref",
    });
    expect(found.get("10.1111/cgf.12271")?.authors?.slice(0, 2)).toHaveLength(2);
  });

  it("strips the markup Crossref leaves in titles", () => {
    const found = parseCrossrefWorks(fixture("crossref-works-batch.json"));

    expect(found.get("10.1109/tg.2024.3497601")?.title).toBe("Will GPT-4 Run DOOM?");
  });

  it("tolerates a body that is not a works list", () => {
    expect(parseCrossrefWorks({ status: "error" }).size).toBe(0);
  });
});

describe("parseCSL", () => {
  it("reads a real DataCite record from doi.org", () => {
    const meta = parseCSL(fixture("doi-csl-datacite.json"));

    expect(meta).toMatchObject({ status: "found", year: 2025, source: "doi.org" });
    expect(meta?.authors?.[0]).toBe("Vincent Schüßler");
    expect(meta?.title).toBeTruthy();
  });

  it("gives nothing for a record without a title", () => {
    expect(parseCSL({ author: [] })).toBeUndefined();
    expect(parseCSL("not json")).toBeUndefined();
  });
});

describe("buildCrossrefBatchURL", () => {
  it("asks for every DOI in one filter", () => {
    const url = new URL(buildCrossrefBatchURL(["10.1/a", "10.2/b"]));

    expect(url.searchParams.get("filter")).toBe("doi:10.1/a,doi:10.2/b");
    expect(url.searchParams.get("rows")).toBe("2");
  });

  it("leaves a DOI with a comma to doi.org, since the filter cannot carry it", () => {
    expect(isBatchableDOI("10.1/a,b")).toBe(false);
    expect(isBatchableDOI("10.1/ab")).toBe(true);
  });
});

const crossrefAnswer = (dois: string[]) =>
  Response.json({
    status: "ok",
    message: {
      items: dois.map((doi) => ({ DOI: doi, title: [`Title of ${doi}`], author: [] })),
    },
  });

describe("MetadataService", () => {
  let store: ItemStore;
  let services: MetadataService[];

  beforeEach(() => {
    store = new ItemStore(":memory:");
    services = [];
  });

  afterEach(() => {
    for (const service of services) {
      service.dispose();
    }
    store.close();
    mock.restore();
  });

  /** Runs one pass and resolves with every batch the service reported. */
  const runOnce = (options: Partial<ConstructorParameters<typeof MetadataService>[0]> = {}) =>
    new Promise<QueueItem[][]>((resolve) => {
      const batches: QueueItem[][] = [];
      const service = new MetadataService({
        store,
        requestIntervalMs: 0,
        retryMs: 60_000,
        onUpdated: (items) => batches.push(items),
        ...options,
      });
      services.push(service);
      service.wake();

      const poll = setInterval(() => {
        if (!(service as unknown as { running: boolean }).running) {
          clearInterval(poll);
          resolve(batches);
        }
      }, 5);
    });

  it("fills listed DOIs from Crossref, then doi.org for the rest", async () => {
    const inCrossref = store.add({ doi: "10.1145/1073204.1073206", origin: "list" });
    const inDataCite = store.add({ doi: "10.2312/sr.20251176", origin: "list" });
    const unregistered = store.add({ doi: "10.1111/cgf142617", origin: "list" });

    const { requestedURLs } = mockFetch(async (input) => {
      const url = getRequestURL(input);
      if (url.startsWith("https://api.crossref.org/")) {
        return crossrefAnswer(["10.1145/1073204.1073206"]);
      }
      if (url.endsWith("10.2312/sr.20251176")) {
        return Response.json(fixture("doi-csl-datacite.json"));
      }
      return new Response("<html>DOI Not Found</html>", { status: 404 });
    });

    await runOnce();

    expect(store.get(inCrossref.id)?.meta).toMatchObject({
      status: "found",
      source: "crossref",
      title: "Title of 10.1145/1073204.1073206",
    });
    expect(store.get(inDataCite.id)?.meta).toMatchObject({ status: "found", source: "doi.org" });
    expect(store.get(unregistered.id)?.meta).toEqual({ status: "missing" });
    // One Crossref request for the whole batch, one doi.org request per miss.
    expect(requestedURLs.filter((url) => url.includes("crossref"))).toHaveLength(1);
    expect(requestedURLs.filter((url) => url.startsWith("https://doi.org/"))).toHaveLength(2);
  });

  it("leaves rows that were not uploaded in a list alone", async () => {
    const fromSearch = store.add({ md5: "b7abef3d085a1007a137a247dcff8dcb", doi: "10.1/x" });
    const { requestedURLs } = mockFetch(async () => crossrefAnswer([]));

    await runOnce();

    expect(requestedURLs).toHaveLength(0);
    expect(store.get(fromSearch.id)?.meta).toBeUndefined();
  });

  it("keeps the DOIs pending when Crossref cannot be reached", async () => {
    const item = store.add({ doi: "10.1145/1073204.1073206", origin: "list" });
    mockFetch(async () => {
      throw new Error("ECONNRESET");
    });

    await runOnce();

    expect(store.get(item.id)?.meta).toBeUndefined();
    expect(store.listNeedingMetadata(10).map((pending) => pending.id)).toEqual([item.id]);
  });

  it("does not touch the history order when metadata arrives", async () => {
    const item = store.add({ doi: "10.1145/1073204.1073206", origin: "list" });
    store.update(item.id, { status: "failed" });
    const before = store.get(item.id)?.updatedAt;
    mockFetch(async () => crossrefAnswer(["10.1145/1073204.1073206"]));

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await runOnce();

    expect(store.get(item.id)?.meta?.status).toBe("found");
    expect(store.get(item.id)?.updatedAt).toBe(before);
  });
});
