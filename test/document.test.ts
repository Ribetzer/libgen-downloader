import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { getDocument, getJSON } from "../src/api/data/document";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { BROWSER_USER_AGENT } from "../src/settings";
import { mockFetch } from "./support/fetch-mock";

// Captured from libgen.li, not written by hand. The capture is what proves the
// point of this file: `ads.php` answers 200 with a zero-byte body unless the
// request carries a browser User-Agent and a Referer, and the empty document
// that produced read downstream as "the mirror has no such record".
const ADS_PAGE = fs.readFileSync(
  path.join(import.meta.dir, "fixtures", "ads-download-page.html"),
  "utf8"
);

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const headers = (init?.headers || {}) as Record<string, string>;
  const lowercased: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowercased[key.toLowerCase()] = value;
  }
  return lowercased;
};

describe("getDocument", () => {
  afterEach(() => {
    mockFetch(async () => new Response("")).fetchMock.mockRestore();
  });

  it("sends a browser User-Agent and a Referer", async () => {
    let seen: RequestInit | undefined;
    const { fetchMock } = mockFetch(async (_input, init) => {
      seen = init;
      return new Response("<html></html>");
    });

    await getDocument("https://libgen.li/ads.php?md5=abc123");

    const headers = headersOf(seen);
    expect(headers["user-agent"]).toBe(BROWSER_USER_AGENT);
    expect(headers["referer"]).toBe("https://libgen.li/");
    fetchMock.mockRestore();
  });

  it("refers to the origin of the requested mirror, not a fixed host", async () => {
    let seen: RequestInit | undefined;
    const { fetchMock } = mockFetch(async (_input, init) => {
      seen = init;
      return new Response("<html></html>");
    });

    await getDocument("https://libgen.vg/ads.php?md5=abc123");

    expect(headersOf(seen)["referer"]).toBe("https://libgen.vg/");
    fetchMock.mockRestore();
  });

  it("sends the same headers when fetching JSON", async () => {
    let seen: RequestInit | undefined;
    const { fetchMock } = mockFetch(async (_input, init) => {
      seen = init;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await getJSON("https://libgen.li/json.php?object=f&md5=abc123");

    const headers = headersOf(seen);
    expect(headers["user-agent"]).toBe(BROWSER_USER_AGENT);
    expect(headers["referer"]).toBe("https://libgen.li/");
    fetchMock.mockRestore();
  });
});

describe("the captured ads.php page", () => {
  it("still yields a download link through the adapter's selector", () => {
    const adapter = new LibgenPlusAdapter("https://libgen.li/");
    const document = parseHTML(ADS_PAGE).document as unknown as Document;

    const downloadURL = adapter.getMainDownloadURLFromDocument(document);

    expect(downloadURL).toBe(
      "https://libgen.li/get.php?md5=f49fcf4849cd50d3e60d85a540b6006e&key=Q17B82OCSGWQ0ISR"
    );
  });

  it("yields nothing from the empty body an unheadered request gets back", () => {
    const adapter = new LibgenPlusAdapter("https://libgen.li/");
    const document = parseHTML("").document as unknown as Document;

    expect(adapter.getMainDownloadURLFromDocument(document)).toBeUndefined();
  });
});
