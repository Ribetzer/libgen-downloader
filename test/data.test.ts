import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { fetchConfig, findMirror } from "../src/api/data/config";
import { getDocument } from "../src/api/data/document";

afterEach(() => {
  mock.restore();
});

describe("configuration data", () => {
  it("normalizes the remote configuration response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        latest_version: "4.0.0",
        mirrors: [{ src: "https://mirror.example/", type: "libgen-plus" }],
      })
    );

    await expect(fetchConfig()).resolves.toEqual({
      latestVersion: "4.0.0",
      mirrors: [{ src: "https://mirror.example/", type: "libgen-plus" }],
    });
  });

  it("wraps configuration transport errors", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(fetchConfig()).rejects.toThrow("Error occurred while fetching configuration.");
  });

  it("selects the first reachable mirror and reports failed mirrors", async () => {
    const onMirrorFail = mock(() => {});
    const fetchMock = spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("ok"));
    const mirrors = [
      { src: "https://offline.example/", type: "libgen-plus" as const },
      { src: "https://online.example/", type: "libgen-plus" as const },
    ];

    await expect(findMirror(mirrors, onMirrorFail)).resolves.toEqual(mirrors[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onMirrorFail).toHaveBeenCalledWith("https://offline.example/");
  });
});

describe("document data", () => {
  it("fetches HTML and returns a queryable document", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<main><h1 id="title">Example Book</h1></main>')
    );

    const result = await getDocument("https://mirror.example/book");

    expect(result.htmlString).toContain("Example Book");
    expect(result.document.querySelector("#title")?.textContent).toBe("Example Book");
  });

  it("wraps document transport errors with the requested URL", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(getDocument("https://mirror.example/book")).rejects.toThrow(
      "Error occured while fetching document of https://mirror.example/book"
    );
  });
});
