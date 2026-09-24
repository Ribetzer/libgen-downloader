import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildFastDownloadURL, fetchAnnasDownloadURL } from "../src/api/sources/annas-archive";
import { normalizeTitle, resetArxivPacing } from "../src/api/sources/arxiv";
import {
  halDocumentURL,
  openAccessSource,
  orderLocations,
  readCitationPDF,
} from "../src/api/sources/open-access";
import type { SourceOutcome, SourceResult } from "../src/api/sources";
import { getRequestURL, mockFetch } from "./support/fetch-mock";

const DOI = "10.1111/cgf.14752";

const itemsOf = (outcome: SourceOutcome): SourceResult[] => {
  if (outcome.status !== "ok") {
    return [];
  }

  return outcome.items;
};

const pdfResponse = () =>
  new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });

const unpaywall = (locations: object[], title = "Line Process Paper") =>
  Response.json({
    title,
    year: 2023,
    z_authors: [{ given: "A", family: "Author" }],
    oa_locations: locations,
  });

/** Wiley's answer to a script, as seen: Cloudflare's "Just a moment...". */
const cloudflareCheck = () =>
  new Response("<title>Just a moment...</title>", {
    status: 403,
    headers: { "content-type": "text/html" },
  });

const arxivFeed = (entries: { id: string; title: string }[]) =>
  new Response(
    [
      '<?xml version="1.0"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">',
      ...entries.map(
        (entry) =>
          `<entry><id>http://arxiv.org/abs/${entry.id}</id><title>${entry.title}</title>` +
          "<published>2023-05-01T00:00:00Z</published><summary>s</summary>" +
          `<link title="pdf" href="http://arxiv.org/pdf/${entry.id}" rel="related" type="application/pdf"/></entry>`
      ),
      "</feed>",
    ].join("")
  );

beforeEach(() => {
  process.env.LIBGEN_OPEN_ACCESS_EMAIL = "someone@example.org";
  resetArxivPacing();
});

afterEach(() => {
  delete process.env.LIBGEN_OPEN_ACCESS_EMAIL;
  mock.restore();
});

describe("orderLocations", () => {
  it("puts repository copies before the publisher's, where the bot checks are", () => {
    const ordered = orderLocations([
      { host_type: "publisher", url: "https://onlinelibrary.wiley.com/x" },
      { host_type: "repository", url: "https://hal.science/y" },
    ]);

    expect(ordered.map((location) => location.host_type)).toEqual(["repository", "publisher"]);
  });
});

describe("halDocumentURL", () => {
  it("gives HAL's stable PDF address for a record's file link", () => {
    // Unpaywall's link for 10.1111/cgf.14766, which HAL now answers with its
    // search page; /document serves the PDF.
    expect(
      halDocumentURL(
        "https://hal.science/hal-03964175v1/file/Computer%20Graphics%20Forum%20-%202023%20-%20Lutz.pdf"
      )
    ).toBe("https://hal.science/hal-03964175/document");
    expect(halDocumentURL("https://polytechnique.hal.science/hal-04027983v1/file/x.pdf")).toBe(
      "https://polytechnique.hal.science/hal-04027983/document"
    );
    expect(halDocumentURL("https://repo.example/record/1")).toBeUndefined();
  });
});

describe("readCitationPDF", () => {
  it("reads the PDF a landing page declares, in either attribute order", () => {
    expect(
      readCitationPDF(
        '<meta name="citation_pdf_url" content="/files/paper.pdf">',
        "https://repo.example/a"
      )
    ).toBe("https://repo.example/files/paper.pdf");
    expect(
      readCitationPDF(
        '<meta content="https://x.example/p.pdf" name="citation_pdf_url">',
        "https://repo.example/"
      )
    ).toBe("https://x.example/p.pdf");
    expect(readCitationPDF("<html></html>", "https://repo.example/")).toBeUndefined();
  });
});

describe("openAccessSource", () => {
  it("takes the repository copy that answers with a PDF, before the publisher's", async () => {
    const { requestedURLs } = mockFetch(async (input) => {
      const url = getRequestURL(input);
      if (url.startsWith("https://api.unpaywall.org/")) {
        return unpaywall([
          {
            host_type: "publisher",
            url_for_pdf: "https://onlinelibrary.wiley.com/doi/pdfdirect/x",
          },
          { host_type: "repository", url: "https://repo.example/record/1" },
        ]);
      }
      if (url === "https://repo.example/record/1") {
        return new Response('<meta name="citation_pdf_url" content="/record/1/files/paper.pdf">', {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://repo.example/record/1/files/paper.pdf") {
        return pdfResponse();
      }
      return cloudflareCheck();
    });

    const outcome = await openAccessSource.search({ kind: "doi", doi: DOI }, 1, {
      candidates: [],
    });
    const items = itemsOf(outcome);
    expect(items[0]).toMatchObject({
      source: "openaccess",
      downloadURL: "https://repo.example/record/1/files/paper.pdf",
      doi: DOI,
      title: "Line Process Paper",
    });
    expect(requestedURLs[0]).toContain("email=someone%40example.org");
    // The repository answered first, so the publisher was never asked.
    expect(requestedURLs.some((url) => url.includes("wiley"))).toBe(false);
  });

  it("does not accept a bot-check page as the PDF", async () => {
    mockFetch(async (input) => {
      if (getRequestURL(input).startsWith("https://api.unpaywall.org/")) {
        return unpaywall(
          [{ host_type: "publisher", url_for_pdf: "https://onlinelibrary.wiley.com/x" }],
          ""
        );
      }
      return cloudflareCheck();
    });

    const outcome = await openAccessSource.search({ kind: "doi", doi: DOI }, 1, {
      candidates: [],
    });

    expect(outcome).toEqual({ status: "ok", items: [] });
  });

  it("finds the arXiv preprint by exact title when no copy answers", async () => {
    const title = "Interpolated corrected curvature measures for polygonal surfaces";
    mockFetch(async (input) => {
      const url = getRequestURL(input);
      if (url.startsWith("https://api.unpaywall.org/")) {
        return unpaywall([], title);
      }
      if (url.includes("export.arxiv.org")) {
        // The first hit is a different paper on the same topic; only the
        // exact title is taken.
        return arxivFeed([
          { id: "9999.00001v1", title: "A different paper on curvature" },
          {
            id: "2305.12345v2",
            title: "Interpolated Corrected Curvature Measures for Polygonal Surfaces",
          },
        ]);
      }
      return new Response("", { status: 404 });
    });

    const outcome = await openAccessSource.search({ kind: "doi", doi: DOI }, 1, {
      candidates: [],
    });
    const items = itemsOf(outcome);
    expect(items[0]).toMatchObject({ source: "arxiv", doi: DOI });
    expect(items[0]?.downloadURL).toContain("2305.12345v2");
  });

  it("stays out of the way without a contact address", () => {
    delete process.env.LIBGEN_OPEN_ACCESS_EMAIL;

    expect(openAccessSource.handles({ kind: "doi", doi: DOI })).toBe(false);
  });
});

describe("normalizeTitle", () => {
  it("ignores case, punctuation and line breaks", () => {
    expect(
      normalizeTitle("Interpolated Corrected Curvature\n   Measures: for Polygonal Surfaces")
    ).toBe(normalizeTitle("interpolated corrected curvature measures for polygonal surfaces"));
  });
});

describe("fetchAnnasDownloadURL", () => {
  it("builds the documented member API request", () => {
    expect(buildFastDownloadURL("annas-archive.gl", "abc", "secret")).toBe(
      "https://annas-archive.gl/dyn/api/fast_download.json?md5=abc&key=secret"
    );
  });

  it("returns the link and the allowance left", async () => {
    mockFetch(async () =>
      Response.json({
        download_url: "https://fast.example/file.pdf",
        account_fast_download_info: { downloads_left: 24 },
      })
    );

    expect(await fetchAnnasDownloadURL("abc", "secret")).toEqual({
      status: "ok",
      downloadURL: "https://fast.example/file.pdf",
      downloadsLeft: 24,
    });
  });

  it("says a bad key can fetch nothing, as the API words it", async () => {
    // The API's own answer to a wrong key, captured through a lane.
    mockFetch(async () => Response.json({ error: "Invalid secret key" }, { status: 401 }));

    expect(await fetchAnnasDownloadURL("abc", "wrong")).toMatchObject({
      status: "error",
      exhausted: true,
    });
  });

  it("treats DDoS-Guard's check page as a miss, not a verdict on the key", async () => {
    mockFetch(async () => new Response("<title>DDoS-Guard</title>", { status: 403 }));

    expect(await fetchAnnasDownloadURL("abc", "secret")).toMatchObject({
      status: "error",
      exhausted: false,
    });
  });
});
