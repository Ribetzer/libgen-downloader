import { describe, expect, it } from "bun:test";
import type { ParsedQuery } from "../src/api/data/query";
import type { Entry } from "../src/api/models/entry";
import type { SourceId, SourceOutcome } from "../src/api/sources";
import { readArticleTitle, readDOI } from "../src/api/sources/libgen";
import { MirrorService } from "../src/server/mirror-service";
import { runSearch, SearchResultItem, withIdentity } from "../src/server/search-service";

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

const item = (overrides: Partial<SearchResultItem>): SearchResultItem => ({
  ...entry({}),
  source: "libgen",
  md5: "",
  downloadURL: "",
  articleTitle: "",
  doi: "",
  ...overrides,
});

describe("withIdentity", () => {
  it("keeps a row identified by an md5", () => {
    expect(withIdentity([item({ md5: "b7abef3d085a1007a137a247dcff8dcb" })])).toHaveLength(1);
  });

  it("keeps a row identified only by a URL", () => {
    // The case the old `withMD5` filter dropped, which is every arXiv and
    // Sci-Hub result on its way to the browser.
    expect(withIdentity([item({ source: "arxiv", downloadURL: "https://x/y.pdf" })])).toHaveLength(
      1
    );
  });

  it("drops a row with neither, which nothing could download", () => {
    expect(withIdentity([item({})])).toHaveLength(0);
  });
});

/** A source that answers with whatever it is told to, for the fan-out tests. */
const stubSource = (id: SourceId, outcome: SourceOutcome, kinds = ["text", "doi", "issue"]) => ({
  id,
  label: id,
  handles: (query: ParsedQuery) => kinds.includes(query.kind),
  search: async () => outcome,
});

const result = (source: SourceId, title: string): SearchResultItem =>
  item({ source, title, articleTitle: title, md5: "b7abef3d085a1007a137a247dcff8dcb" });

describe("runSearch across sources", () => {
  const mirrors = new MirrorService();

  it("merges what every source returned, grouped in source order", async () => {
    const outcome = await runSearch(mirrors, "marching cubes", 1, [
      stubSource("libgen", { status: "ok", items: [result("libgen", "from libgen")] }),
      stubSource("arxiv", { status: "ok", items: [result("arxiv", "from arxiv")] }),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    expect(outcome.items.map((found) => found.source)).toEqual(["libgen", "arxiv"]);
  });

  it("still returns LibGen's results when another source is down", async () => {
    // The point of the fan-out. arXiv being unreachable is not a reason to
    // withhold results that were fetched successfully.
    const outcome = await runSearch(mirrors, "marching cubes", 1, [
      stubSource("libgen", { status: "ok", items: [result("libgen", "still here")] }),
      stubSource("arxiv", { status: "error", message: "arXiv answered HTTP 503" }),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    expect(outcome.items).toHaveLength(1);
    // …and the reason it is missing travels with them rather than vanishing.
    expect(outcome.notes).toEqual([{ source: "arxiv", message: "arXiv answered HTTP 503" }]);
  });

  it("reports an error only when every source that was asked has failed", async () => {
    const outcome = await runSearch(mirrors, "marching cubes", 1, [
      stubSource("libgen", { status: "error", message: "No mirror available" }),
      stubSource("arxiv", { status: "error", message: "arXiv answered HTTP 503" }),
    ]);

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") {
      return;
    }

    expect(outcome.message).toContain("No mirror available");
    expect(outcome.message).toContain("arXiv answered HTTP 503");
  });

  it("does not ask a source about a query it cannot answer", async () => {
    let asked = false;
    const scihub = {
      ...stubSource("scihub", { status: "ok", items: [] }, ["doi"]),
      search: async () => {
        asked = true;
        return { status: "ok", items: [] } as SourceOutcome;
      },
    };

    await runSearch(mirrors, "marching cubes", 1, [
      stubSource("libgen", { status: "ok", items: [result("libgen", "a book")] }),
      scihub,
    ]);

    // Sci-Hub has no text index; asking it and counting the failure would turn
    // a healthy search into a reported error.
    expect(asked).toBe(false);
  });

  it("survives a source that throws rather than returning an error", async () => {
    const outcome = await runSearch(mirrors, "marching cubes", 1, [
      stubSource("libgen", { status: "ok", items: [result("libgen", "a book")] }),
      {
        id: "arxiv" as const,
        label: "arXiv",
        handles: () => true,
        search: async () => {
          throw new Error("getaddrinfo ENOTFOUND export.arxiv.org");
        },
      },
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    expect(outcome.items).toHaveLength(1);
    expect(outcome.notes[0].message).toContain("ENOTFOUND");
  });
});
