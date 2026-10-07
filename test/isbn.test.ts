import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";

import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import { buildDownloadFileName } from "../src/api/data/filename";
import { isbn13, normalizeISBN } from "../src/api/data/isbn";
import { parseQuery } from "../src/api/data/query";

// LibGen stores ISBNs as bare digits, so searching the dashed form a
// publisher prints ("978-3-642-12020-6") finds nothing (Dom, 2026-10-08).
describe("normalizeISBN", () => {
  it("reduces a dashed or spaced ISBN to its digits", () => {
    expect(normalizeISBN("978-3-642-12020-6")).toBe("9783642120206");
    expect(normalizeISBN("ISBN 978 0 262 03384 8")).toBe("9780262033848");
    expect(normalizeISBN("0-262-03384-4")).toBe("0262033844");
    expect(normalizeISBN("0-8044-2957-X")).toBe("080442957X");
  });

  it("refuses what is not an ISBN, checksum included", () => {
    expect(normalizeISBN("978-3-642-12020-7")).toBeUndefined();
    expect(normalizeISBN("Introduction to Algorithms")).toBeUndefined();
    expect(normalizeISBN("12345")).toBeUndefined();
    expect(normalizeISBN("10.1007/978-3-642-12020-6")).toBeUndefined();
  });

  it("turns an ISBN-10 into its ISBN-13", () => {
    expect(isbn13("0262033844")).toBe("9780262033848");
    expect(isbn13("9783642120206")).toBe("9783642120206");
  });
});

describe("searching by ISBN", () => {
  it("searches LibGen with the bare digits", () => {
    expect(parseQuery("978-3-642-12020-6")).toEqual({ kind: "text", query: "9783642120206" });
  });

  it("leaves a book DOI built from an ISBN a DOI", () => {
    expect(parseQuery("10.1007/978-3-642-12020-6").kind).toBe("doi");
  });
});

describe("the ISBN on LibGen's download page", () => {
  const html = readFileSync(
    path.join(import.meta.dir, "fixtures", "ads-download-page.html"),
    "utf8"
  );
  const { document } = parseHTML(html);
  const adapter = new LibgenPlusAdapter("https://libgen.li");

  it("reads every ISBN the page lists, as ISBN-13", () => {
    // The page says "ISBN: 9780262033848; 0262033844" - one book, two forms.
    expect(adapter.getISBNsFromDocument(document)).toEqual(["9780262033848"]);
  });
});

describe("a book's file name carries its ISBN", () => {
  it("adds the ISBN where there is no DOI, in the [digits] label the RAG reads", () => {
    expect(
      buildDownloadFileName(
        "book.pdf",
        150,
        "Introduction to Algorithms (2011)",
        "",
        "9780262033848"
      )
    ).toBe("Introduction to Algorithms (2011) [9780262033848].pdf");
  });

  it("keeps the DOI alone when there is one", () => {
    expect(
      buildDownloadFileName(
        "x.pdf",
        150,
        "A Chapter (2010)",
        "10.1007/978-3-642-12020-6_29",
        "9783642120206"
      )
    ).toBe("A Chapter (2010) [10.1007_978-3-642-12020-6_29].pdf");
  });
});
