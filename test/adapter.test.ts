import { describe, expect, it, mock } from "bun:test";
import { parseHTML } from "linkedom";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";

const parseDocument = (html: string) => parseHTML(html).document as unknown as Document;

describe("LibgenPlusAdapter", () => {
  const adapter = new LibgenPlusAdapter("https://libgen.example/");

  it("constructs search, detail, and relative page URLs", () => {
    expect(adapter.getSearchURL("clean code", 2, 25)).toBe(
      "https://libgen.example/index.php?req=clean+code&page=2&res=25"
    );
    expect(adapter.getDetailPageURL("abc123")).toBe("https://libgen.example/ads.php?md5=abc123");
    expect(adapter.getPageURL("/book.epub")).toBe("https://libgen.example/book.epub");
  });

  it("parses result rows into normalized entries", () => {
    const document = parseDocument(`
      <table id="tablelibgen">
        <tbody>
          <tr>
            <td><a>Primary Title</a><span>Subtitle</span><nobr>ignored</nobr></td>
            <td>Alice Example; Bob Example</td>
            <td>Example Press</td>
            <td>2026</td>
            <td>English</td>
            <td>321</td>
            <td>2 MB</td>
            <td>epub</td>
            <td><a href="/ads.php?md5=abc123">Mirror</a></td>
          </tr>
        </tbody>
      </table>
    `);

    const entries = adapter.parseEntries(document);

    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      authors: "Alice Example, Bob Example",
      title: "Primary Title / Subtitle",
      publisher: "Example Press",
      year: "2026",
      language: "English",
      pages: "321",
      size: "2 MB",
      extension: "epub",
      mirror: "/ads.php?md5=abc123",
    });
    expect(entries?.[0].id).toBeTruthy();
  });

  it("extracts the primary download URL and connection errors", () => {
    const document = parseDocument(`
      <table id="main"><tr><td>Book</td><td><a href="/get/book.epub">GET</a></td></tr></table>
      <div class="alert-danger">Mirror temporarily unavailable</div>
    `);

    expect(adapter.getMainDownloadURLFromDocument(document)).toBe(
      "https://libgen.example/get/book.epub"
    );
    expect(adapter.detectConnectionError(document)).toBe("Mirror temporarily unavailable");
  });

  it("returns an empty result and reports malformed result pages", () => {
    const onError = mock(() => {});

    expect(adapter.parseEntries(parseDocument("<main>no results table</main>"), onError)).toEqual(
      []
    );
    expect(onError).toHaveBeenCalledWith("containerTable is undefined");
  });
});
