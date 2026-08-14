import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { getEditionMD5s, normalizeDOI, parseEditionsJSON } from "../src/api/data/edition";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const adapter = new LibgenPlusAdapter("https://libgen.li/");

describe("parseEditionsJSON", () => {
  it("reads a DOI lookup captured from libgen.li", () => {
    const records = parseEditionsJSON(JSON.parse(readFixture("edition-by-doi.json")));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      editionId: "39086967",
      title:
        "Fast Relabeling of Deformable Delaunay Tetrahedral Meshes Using a Compact Uniform Grid",
      author: "Frogley, D.; Jones, M. D.",
      year: "2013",
      doi: "10.1080/2165347X.2013.870057",
      issueVolume: "17",
      issueNumber: "1-2",
      pages: "17-29",
      files: [{ fileId: "39124575", md5: "e9a3bcfba6664166a0a12bcfe57b6d67" }],
    });
  });

  it("reads every edition of a captured issue", () => {
    const records = parseEditionsJSON(JSON.parse(readFixture("issue-editions.json")));

    expect(records).toHaveLength(18);
    expect(getEditionMD5s(records)).toHaveLength(18);
    expect(records.every((record) => record.title.length > 0)).toBe(true);
  });

  it("treats an empty or failed lookup as no records", () => {
    expect(parseEditionsJSON([])).toEqual([]);
    expect(parseEditionsJSON({ error: "No Request keys" })).toEqual([]);
    expect(parseEditionsJSON(JSON.parse("null"))).toEqual([]);
    expect(parseEditionsJSON("nonsense")).toEqual([]);
  });

  it("keeps an edition that carries no file, with no MD5s", () => {
    const records = parseEditionsJSON({ 42: { title: "Announcement", year: "1999" } });

    expect(records[0]?.files).toEqual([]);
    expect(getEditionMD5s(records)).toEqual([]);
  });
});

describe("normalizeDOI", () => {
  it("accepts the forms a DOI is usually pasted in", () => {
    const expected = "10.1080/2165347X.2013.870057";

    expect(normalizeDOI(expected)).toBe(expected);
    expect(normalizeDOI("  10.1080/2165347X.2013.870057 ")).toBe(expected);
    expect(normalizeDOI("doi:10.1080/2165347X.2013.870057")).toBe(expected);
    expect(normalizeDOI("https://doi.org/10.1080/2165347X.2013.870057")).toBe(expected);
    expect(normalizeDOI("https://dx.doi.org/10.1080%2F2165347X.2013.870057")).toBe(expected);
  });

  it("rejects anything that is not a DOI", () => {
    expect(normalizeDOI("clean code")).toBeUndefined();
    expect(normalizeDOI("10.1080")).toBeUndefined();
    expect(normalizeDOI("issuesid:13647")).toBeUndefined();
  });
});

describe("LibgenPlusAdapter lookup URLs", () => {
  it("builds the JSON API URLs", () => {
    expect(adapter.getEditionByDOIURL("10.1080/2165347X.2013.870057")).toBe(
      "https://libgen.li/json.php?object=e&doi=10.1080%2F2165347X.2013.870057&fields=*"
    );
    expect(adapter.getEditionsByIdsURL(["1", "2"])).toBe(
      "https://libgen.li/json.php?object=e&ids=1%2C2&fields=*"
    );
  });

  it("builds the editions tab search URL, with and without a volume", () => {
    expect(
      adapter.getIssueSearchURL({ issuesId: "13647", volume: "17", pageNumber: 1, pageSize: 100 })
    ).toBe(
      "https://libgen.li/index.php?req=issuesid%3A13647+issuevolume%3A17&gmode=on&topics1=all&curtab=e&res=100&page=1"
    );
    expect(adapter.getIssueSearchURL({ issuesId: "13647", pageNumber: 2, pageSize: 25 })).toBe(
      "https://libgen.li/index.php?req=issuesid%3A13647&gmode=on&topics1=all&curtab=e&res=25&page=2"
    );
  });

  it("pulls the edition ids out of a captured results table", () => {
    const document = parseHTML(readFixture("issue-search-table.html"))
      .document as unknown as Document;

    const editionIds = adapter.parseEditionIds(document);

    // Each row links to its edition from several columns.
    expect(editionIds).toHaveLength(18);
    expect(editionIds).toContain("39086967");
    expect(new Set(editionIds).size).toBe(editionIds.length);
  });
});
