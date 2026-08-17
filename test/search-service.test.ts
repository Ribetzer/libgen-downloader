import { describe, expect, it } from "bun:test";
import type { Entry } from "../src/api/models/entry";
import { readArticleTitle, readDOI } from "../src/server/search-service";

const entry = (overrides: Partial<Entry>): Entry => ({
  id: "x",
  authors: "",
  title: "",
  publisher: "",
  year: "",
  pages: "",
  language: "",
  size: "",
  extension: "pdf",
  mirror: "",
  ...overrides,
});

describe("readArticleTitle", () => {
  it("takes the article title out of a journal-and-issue line", () => {
    // Exactly what libgen.li returned for a "dual contouring" file search.
    const title =
      "Engineering with Computers    2013-sep 22 vol. 30 iss. 2 pp.211—222 / " +
      "An octree-based dual contouring method";

    expect(readArticleTitle(title)).toBe("An octree-based dual contouring method");
  });

  it("drops the trailing DOI segment, which would break an exact title match", () => {
    const title =
      "ACM Transactions on Graphics    2002-jul vol. 21 iss. 3 pp.339—346 / " +
      "Dual contouring of hermite data / DOI: 10.1145/566654.566586";

    expect(readArticleTitle(title)).toBe("Dual contouring of hermite data");
  });

  it("keeps a slash that belongs to the article title", () => {
    const title = "ACM TOG    2002-jul vol. 21 / Rendering and / or shading";
    expect(readArticleTitle(title)).toBe("Rendering and / or shading");
  });

  it("keeps an internal slash even with a DOI segment present", () => {
    const title = "ACM TOG    2002 / Rendering and / or shading / DOI: 10.1145/1.2";
    expect(readArticleTitle(title)).toBe("Rendering and / or shading");
  });

  it("passes through a title with no journal prefix", () => {
    // Books, and everything the JSON API returns, are already just a title.
    expect(readArticleTitle("Level Set Methods and Dynamic Implicit Surfaces")).toBe(
      "Level Set Methods and Dynamic Implicit Surfaces"
    );
  });

  it("keeps the whole string when nothing follows the separator", () => {
    expect(readArticleTitle("Journal of Things / ")).toBe("Journal of Things /");
  });

  it("handles an empty title", () => {
    expect(readArticleTitle("")).toBe("");
  });
});

describe("readDOI", () => {
  it("reads the DOI libgen appends to the title", () => {
    const result = readDOI(
      entry({
        title:
          "ACM Transactions on Graphics    2002-jul vol. 21 iss. 3 pp.339—346 / " +
          "Dual contouring of hermite data / DOI: 10.1145/566654.566586",
      })
    );

    expect(result).toBe("10.1145/566654.566586");
  });

  it("reads the DOI libgen hangs off the detail link", () => {
    const result = readDOI(
      entry({
        mirror:
          "https://libgen.li/ads.php?md5=a0563a0244b727b7905a2ef7dba8c19a" +
          "&downloadname=10.1109/tvcg.2007.1018",
      })
    );

    expect(result).toBe("10.1109/tvcg.2007.1018");
  });

  it("falls back to the publisher field, which is where the JSON API puts it", () => {
    expect(readDOI(entry({ publisher: "10.1145/37402.37422" }))).toBe("10.1145/37402.37422");
  });

  it("is empty when the download name is not a DOI", () => {
    expect(readDOI(entry({ mirror: "https://libgen.li/ads.php?downloadname=book.pdf" }))).toBe("");
  });

  it("is empty when there is no DOI anywhere", () => {
    expect(
      readDOI(entry({ mirror: "https://libgen.li/ads.php?md5=abc", publisher: "Springer" }))
    ).toBe("");
  });

  it("does not throw on a relative or malformed link", () => {
    expect(readDOI(entry({ mirror: "/ads.php?md5=abc" }))).toBe("");
  });
});
