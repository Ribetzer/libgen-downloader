import { afterEach, describe, expect, it, mock } from "bun:test";
import { CorpusService } from "../src/server/corpus-service";
import { mockFetch } from "./support/fetch-mock";

const BODY = JSON.stringify({ items: [{ title: "A paper" }, { title: "Another" }] });

afterEach(() => {
  mock.restore();
});

describe("CorpusService", () => {
  it("reports which results the library already holds", async () => {
    mockFetch(async () => Response.json({ owned: [0, 2] }));

    const corpus = new CorpusService({ url: "https://library.example" });
    expect(await corpus.owned(BODY)).toEqual({ owned: [0, 2], configured: true });
  });

  it("asks the library at its /api/owned endpoint", async () => {
    const fetchMock = mockFetch(async () => Response.json({ owned: [] }));

    // A trailing slash must not produce a double slash in the path.
    await new CorpusService({ url: "https://library.example/" }).owned(BODY);

    expect(fetchMock.requestedURLs).toEqual(["https://library.example/api/owned"]);
  });

  it("says so plainly when no library is configured", async () => {
    const fetchMock = mockFetch(async () => Response.json({ owned: [0] }));

    const result = await new CorpusService({ url: "" }).owned(BODY);

    expect(result).toEqual({ owned: [], configured: false });
    // Nothing configured means nothing asked.
    expect(fetchMock.requestedURLs).toEqual([]);
  });

  it("degrades to no annotation when the library is down", async () => {
    mockFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await new CorpusService({ url: "https://library.example" }).owned(BODY);

    // A search must still return results; this is an annotation, not a gate.
    expect(result.owned).toEqual([]);
    expect(result.configured).toBe(true);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("degrades when the library answers with an error status", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));

    const result = await new CorpusService({ url: "https://library.example" }).owned(BODY);

    expect(result.owned).toEqual([]);
    expect(result.error).toBe("library answered 500");
  });

  it("ignores an answer that is not a list of indices", async () => {
    mockFetch(async () => Response.json({ owned: "everything" }));

    const result = await new CorpusService({ url: "https://library.example" }).owned(BODY);

    expect(result.owned).toEqual([]);
    expect(result.error).toContain("unexpected shape");
  });

  it("drops entries that could not address the list that was sent", async () => {
    mockFetch(async () => Response.json({ owned: [0, -1, 1.5, "2", undefined, 3] }));

    const result = await new CorpusService({ url: "https://library.example" }).owned(BODY);

    expect(result.owned).toEqual([0, 3]);
  });
});
