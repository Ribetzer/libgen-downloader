import { afterEach, describe, expect, it, mock } from "bun:test";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import type { MirrorCandidate } from "../src/api/data/resolve";
import { resolveDownloadURL } from "../src/api/data/resolve";
import { mockFetch } from "./support/fetch-mock";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";

const DOWNLOAD_PAGE =
  '<table id="main"><tr><td>Book</td><td><a href="/files/book.epub">GET</a></td></tr></table>';
const EMPTY_PAGE = "<html><body>No record</body></html>";
const ERROR_PAGE = '<div class="alert-danger">Database is unavailable</div>';

const createCandidate = (host: string): MirrorCandidate => ({
  mirror: { src: `https://${host}/`, type: "libgen-plus" },
  adapter: new LibgenPlusAdapter(`https://${host}/`),
});

afterEach(() => {
  mock.restore();
});

describe("resolveDownloadURL", () => {
  it("returns the book's ISBN from the page it already fetched", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(`${import.meta.dir}/fixtures/ads-download-page.html`, "utf8");
    mockFetch(async () => new Response(page));

    const result = await resolveDownloadURL({
      md5: MD5,
      candidates: [createCandidate("libgen.example")],
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.isbn).toBe("9780262033848");
    }
  });

  it("falls through to a mirror that holds the record", async () => {
    const { requestedURLs } = mockFetch(async (input) => {
      if (input.toString().startsWith("https://second.example/")) {
        return new Response(DOWNLOAD_PAGE);
      }

      return new Response(EMPTY_PAGE);
    });

    const result = await resolveDownloadURL({
      md5: MD5,
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      throw new Error("Expected the second mirror to resolve");
    }
    expect(result.downloadURL).toBe("https://second.example/files/book.epub");
    expect(result.candidate.mirror.src).toBe("https://second.example/");
    expect(requestedURLs).toEqual([
      `https://first.example/ads.php?md5=${MD5}`,
      `https://second.example/ads.php?md5=${MD5}`,
    ]);
  });

  it("reports not_found when every mirror answers without the record", async () => {
    mockFetch(async () => new Response(EMPTY_PAGE));

    const result = await resolveDownloadURL({
      md5: MD5,
      candidates: [createCandidate("first.example"), createCandidate("second.example")],
    });

    expect(result).toEqual({
      status: "not_found",
      checkedMirrors: ["https://first.example/", "https://second.example/"],
    });
  });

  it("reports unreachable and flags mirrors that answer with a connection error", async () => {
    mockFetch(async () => new Response(ERROR_PAGE));
    const onMirrorUnreachable = mock(() => {});

    const result = await resolveDownloadURL({
      md5: MD5,
      candidates: [createCandidate("first.example")],
      onMirrorUnreachable,
    });

    expect(result.status).toBe("unreachable");
    expect(onMirrorUnreachable).toHaveBeenCalledWith("https://first.example/");
  });

  it("reports unreachable without checked mirrors when there is nothing to try", async () => {
    const result = await resolveDownloadURL({ md5: MD5, candidates: [] });

    expect(result).toEqual({ status: "unreachable", checkedMirrors: [] });
  });
});
