import { beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  arxivSource,
  arxivWaitMs,
  buildArxivSearchURL,
  parseArxivFeed,
  readArxivId,
  resetArxivPacing,
  toEntry,
} from "../src/api/sources/arxiv";
import { ARXIV_MIN_INTERVAL_MS, ARXIV_USER_AGENT } from "../src/settings";
import { mockFetch } from "./support/fetch-mock";

// Captured from export.arxiv.org, not hand-written - the same convention the
// LibGen fixtures follow, and the reason the namespaced-field problem showed
// up at all.
const FEED = fs.readFileSync(path.join(import.meta.dir, "fixtures", "arxiv-search.xml"), "utf8");

describe("readArxivId", () => {
  it("keeps the version, which is part of the identity", () => {
    expect(readArxivId("http://arxiv.org/abs/2304.00359v1")).toBe("2304.00359v1");
  });

  it("ignores anything that is not an abstract URL", () => {
    expect(readArxivId("https://example.com/paper")).toBe("");
  });
});

describe("parseArxivFeed", () => {
  it("reads every entry in a real response", () => {
    const records = parseArxivFeed(FEED);

    expect(records).toHaveLength(3);
    expect(records.every((record) => record.id.length > 0)).toBe(true);
  });

  it("takes the PDF link arXiv states rather than rewriting the abstract URL", () => {
    const [first] = parseArxivFeed(FEED);

    expect(first.pdfURL).toStartWith("https://arxiv.org/pdf/");
    expect(first.pdfURL).toContain(first.id);
  });

  it("collapses the whitespace arXiv wraps titles with", () => {
    // Titles arrive wrapped at the source, so a raw textContent carries
    // newlines and runs of spaces inside the sentence.
    const [first] = parseArxivFeed(FEED);

    expect(first.title).not.toContain("\n");
    expect(first.title).not.toContain("  ");
  });

  it("reads the authors in order", () => {
    const [first] = parseArxivFeed(FEED);

    expect(first.authors.length).toBeGreaterThan(0);
    expect(first.authors[0]).not.toContain("\n");
  });

  it("skips an entry with no PDF link rather than inventing one", () => {
    const withoutPDF = `<feed><entry>
      <id>http://arxiv.org/abs/1234.5678v1</id>
      <title>No file here</title>
      <link href="https://arxiv.org/abs/1234.5678v1" rel="alternate" type="text/html"/>
    </entry></feed>`;

    expect(parseArxivFeed(withoutPDF)).toHaveLength(0);
  });

  it("reads a namespaced DOI, which querySelector cannot address", () => {
    // `linkedom` finds nothing for `querySelector("arxiv:doi")`, so the
    // children are scanned by local name instead.
    const withDOI = `<feed><entry>
      <id>http://arxiv.org/abs/1234.5678v1</id>
      <title>Published later</title>
      <link href="https://arxiv.org/pdf/1234.5678v1" rel="related" type="application/pdf"/>
      <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1109/ICCV.2023.00151</arxiv:doi>
    </entry></feed>`;

    expect(parseArxivFeed(withDOI)[0].doi).toBe("10.1109/ICCV.2023.00151");
  });

  it("leaves the DOI empty when the preprint has not been published", () => {
    expect(parseArxivFeed(FEED)[0].doi).toBe("");
  });
});

describe("buildArxivSearchURL", () => {
  it("quotes the phrase so the words are not searched separately", () => {
    const url = buildArxivSearchURL("signed distance field", 1, 10);

    expect(url).toContain("search_query=all%3A%22signed+distance+field%22");
  });

  it("pages by offset, which is what arXiv takes", () => {
    expect(buildArxivSearchURL("x", 3, 10)).toContain("start=20");
    expect(buildArxivSearchURL("x", 1, 10)).toContain("start=0");
  });

  it("treats page zero as the first page rather than a negative offset", () => {
    expect(buildArxivSearchURL("x", 0, 10)).toContain("start=0");
  });
});

describe("toEntry", () => {
  it("links to the abstract page, not the PDF", () => {
    // The mirror field is what a person clicks; the PDF travels separately as
    // the download URL.
    const entry = toEntry(parseArxivFeed(FEED)[0]);

    expect(entry.mirror).toStartWith("https://arxiv.org/abs/");
    expect(entry.id).toStartWith("arxiv:");
    expect(entry.extension).toBe("pdf");
  });

  it("takes the year from the published date", () => {
    const entry = toEntry(parseArxivFeed(FEED)[0]);

    expect(entry.year).toMatch(/^\d{4}$/);
  });
});

describe("arxivWaitMs", () => {
  it("lets the first request go straight out", () => {
    expect(arxivWaitMs(1_000_000, 0)).toBe(0);
  });

  it("holds a request that arrives inside the interval", () => {
    // arXiv asks for one request every three seconds; this is the whole of
    // keeping that promise.
    expect(arxivWaitMs(1_001_000, 1_000_000)).toBe(ARXIV_MIN_INTERVAL_MS - 1000);
  });

  it("does not hold one that arrives after it", () => {
    expect(arxivWaitMs(1_010_000, 1_000_000)).toBe(0);
  });
});

describe("arxivSource", () => {
  beforeEach(() => {
    // Otherwise the second test in the file sits out a real three seconds.
    resetArxivPacing();
  });

  it("takes a text query and nothing else", () => {
    expect(arxivSource.handles({ kind: "text", query: "signed distance field" })).toBe(true);
    // arXiv's search fields are ti/au/abs/co/jr/cat/rn/id/all - there is no
    // `doi:`, and asking for one returns an empty feed rather than an error,
    // which would read as "arXiv has nothing" instead of "wrong question".
    expect(arxivSource.handles({ kind: "doi", doi: "10.1145/37402.37422" })).toBe(false);
    expect(arxivSource.handles({ kind: "issue", issuesId: "13647" })).toBe(false);
  });

  it("identifies itself, as arXiv's terms of use ask", async () => {
    let sentAgent = "";
    const { fetchMock } = mockFetch(async (_input, init) => {
      sentAgent = ((init?.headers || {}) as Record<string, string>)["user-agent"] || "";
      return new Response(FEED);
    });

    await arxivSource.search({ kind: "text", query: "signed distance field" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(sentAgent).toBe(ARXIV_USER_AGENT);
  });

  it("returns results carrying a URL and no md5", async () => {
    const { fetchMock } = mockFetch(async () => new Response(FEED));

    const outcome = await arxivSource.search({ kind: "text", query: "anything" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    expect(outcome.items).toHaveLength(3);
    expect(outcome.items.every((item) => item.source === "arxiv")).toBe(true);
    expect(outcome.items.every((item) => item.md5 === "")).toBe(true);
    expect(outcome.items.every((item) => item.downloadURL.startsWith("https://"))).toBe(true);
    // No journal line to strip, so the two titles are the same string.
    expect(outcome.items[0].articleTitle).toBe(outcome.items[0].title);
  });

  it("reports a bad status rather than treating it as an empty result", async () => {
    const { fetchMock } = mockFetch(async () => new Response("", { status: 503 }));

    const outcome = await arxivSource.search({ kind: "text", query: "anything" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(outcome).toEqual({ status: "error", message: "arXiv answered HTTP 503" });
  });
});
