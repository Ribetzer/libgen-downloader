import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { getEditionMD5s } from "../src/api/data/edition";
import { lookupEditionByDOI, lookupIssueEditions } from "../src/api/data/lookup";
import type { MirrorCandidate } from "../src/api/data/resolve";
import { mockFetch } from "./support/fetch-mock";

const DOI = "10.1080/2165347X.2013.870057";
const FIXTURES = path.join(import.meta.dir, "fixtures");
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const createCandidate = (host: string): MirrorCandidate => ({
  mirror: { src: `https://${host}/`, type: "libgen-plus" },
  adapter: new LibgenPlusAdapter(`https://${host}/`),
});

afterEach(() => {
  mock.restore();
});

describe("lookupEditionByDOI", () => {
  it("falls through to the mirror that carries the record", async () => {
    const { requestedURLs } = mockFetch(async (input) => {
      if (input.toString().startsWith("https://second.example/")) {
        return new Response(readFixture("edition-by-doi.json"));
      }

      // An empty array is what libgen answers for a DOI it does not hold.
      return new Response("[]");
    });

    const result = await lookupEditionByDOI(DOI, {
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
    });

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("Expected the second mirror to hold the record");
    }
    expect(result.candidate.mirror.src).toBe("https://second.example/");
    expect(getEditionMD5s(result.records)).toEqual(["e9a3bcfba6664166a0a12bcfe57b6d67"]);
    expect(requestedURLs[0]).toBe(
      `https://first.example/json.php?object=e&doi=${encodeURIComponent(DOI)}&fields=*`
    );
  });

  it("reports not_found when every mirror answers with nothing", async () => {
    mockFetch(async () => new Response("[]"));

    const result = await lookupEditionByDOI(DOI, {
      candidates: [createCandidate("first.example")],
    });

    expect(result).toEqual({
      status: "not_found",
      checkedMirrors: ["https://first.example/"],
    });
  });

  it("reports unreachable and flags the mirror when nothing answers", async () => {
    mockFetch(async () => {
      throw new Error("connection refused");
    });
    const onMirrorUnreachable = mock(() => {});

    const result = await lookupEditionByDOI(DOI, {
      candidates: [createCandidate("first.example")],
      onMirrorUnreachable,
    });

    expect(result.status).toBe("unreachable");
    expect(onMirrorUnreachable).toHaveBeenCalledWith("https://first.example/");
  });
});

describe("lookupIssueEditions", () => {
  it("collects the edition ids from the results page, then resolves them to files", async () => {
    const { requestedURLs } = mockFetch(async (input) => {
      if (input.toString().includes("index.php")) {
        return new Response(readFixture("issue-search-table.html"));
      }

      return new Response(readFixture("issue-editions.json"));
    });

    const result = await lookupIssueEditions({
      issuesId: "13647",
      volume: "17",
      candidates: [createCandidate("first.example")],
    });

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("Expected the issue to resolve");
    }
    expect(result.records).toHaveLength(18);
    expect(getEditionMD5s(result.records)).toHaveLength(18);

    // One page of results, then one batched lookup for its editions.
    expect(requestedURLs).toHaveLength(2);
    expect(requestedURLs[0]).toContain("curtab=e");
    expect(requestedURLs[0]).toContain("req=issuesid%3A13647+issuevolume%3A17");
    expect(requestedURLs[1]).toContain("json.php?object=e&ids=");
    expect(requestedURLs[1]).toContain("39086967");
  });

  it("stops paging when a page repeats what was already collected", async () => {
    const { requestedURLs } = mockFetch(async (input) => {
      if (input.toString().includes("index.php")) {
        return new Response(readFixture("issue-search-table.html"));
      }

      return new Response(readFixture("issue-editions.json"));
    });

    await lookupIssueEditions({
      issuesId: "13647",
      candidates: [createCandidate("first.example")],
    });

    // 18 ids is short of a full page, so the second page is never requested.
    expect(requestedURLs.filter((url) => url.includes("index.php"))).toHaveLength(1);
  });
});
