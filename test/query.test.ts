import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { parseEditionsJSON, parseFileDetailsJSON } from "../src/api/data/edition";
import { buildEntriesFromEditions } from "../src/api/data/edition-entry";
import { parseQuery } from "../src/api/data/query";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("parseQuery", () => {
  it("recognizes a DOI in the forms it gets pasted in", () => {
    expect(parseQuery("10.1080/2165347X.2013.870057")).toEqual({
      kind: "doi",
      doi: "10.1080/2165347X.2013.870057",
    });
    expect(parseQuery("https://doi.org/10.1080/2165347X.2013.870057")).toMatchObject({
      kind: "doi",
    });
  });

  it("recognizes libgen's issue syntax, with and without a volume", () => {
    expect(parseQuery("issuesid:13647 issuevolume:17")).toEqual({
      kind: "issue",
      issuesId: "13647",
      volume: "17",
    });
    expect(parseQuery("issuesid:13647")).toEqual({
      kind: "issue",
      issuesId: "13647",
      volume: undefined,
    });
    expect(parseQuery("ISSUESID: 13647 ISSUEVOLUME: 17")).toMatchObject({
      kind: "issue",
      issuesId: "13647",
    });
  });

  it("leaves an ordinary search alone", () => {
    expect(parseQuery("  the art of war ")).toEqual({ kind: "text", query: "the art of war" });
    expect(parseQuery("10.1080")).toEqual({ kind: "text", query: "10.1080" });
  });
});

describe("buildEntriesFromEditions", () => {
  const adapter = new LibgenPlusAdapter("https://libgen.li/");

  it("turns captured records into entries the result list can render", () => {
    const records = parseEditionsJSON(JSON.parse(readFixture("issue-editions.json")));
    const fileDetails = parseFileDetailsJSON(JSON.parse(readFixture("file-details.json")));

    const entries = buildEntriesFromEditions(records, fileDetails, adapter);

    expect(entries).toHaveLength(18);

    const entry = entries.find((candidate) => candidate.title.startsWith("Fast Relabeling"));
    expect(entry).toMatchObject({
      authors: "Frogley, D.; Jones, M. D.",
      year: "2013",
      pages: "17-29",
      publisher: "10.1080/2165347X.2013.870057",
      extension: "pdf",
      size: "783.48 KB",
      mirror: "https://libgen.li/ads.php?md5=e9a3bcfba6664166a0a12bcfe57b6d67",
    });
    expect(entry?.id).toBeTruthy();
  });

  it("still yields an entry when the file details lookup came back empty", () => {
    const records = parseEditionsJSON(JSON.parse(readFixture("edition-by-doi.json")));

    const entries = buildEntriesFromEditions(records, new Map(), adapter);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ extension: "", size: "" });
    expect(entries[0].mirror).toContain("ads.php?md5=");
  });
});
