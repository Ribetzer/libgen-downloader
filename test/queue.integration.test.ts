import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import type { Entry } from "../src/api/models/entry";
import { DownloadStatus } from "../src/download-statuses";
import { initialAppState } from "../src/tui/store/app";
import { initialBulkDownloadQueueState } from "../src/tui/store/bulk-download-queue";
import { initialConfigState } from "../src/tui/store/config";
import { initialDownloadQueueState } from "../src/tui/store/download-queue";
import { useBoundStore } from "../src/tui/store";
import { getRequestURL, mockFetch } from "./support/fetch-mock";

const BASE_URL = "https://libgen.example/";
// Not a real directory, so nothing is ever treated as already downloaded.
const OUTPUT_DIRECTORY = path.join(os.tmpdir(), "libgen-downloader-test-output");
const originalStoreState = useBoundStore.getState();

const createEntry = (id: string, md5: string): Entry => ({
  id,
  authors: "Example Author",
  title: `Example Book ${id}`,
  publisher: "Example Press",
  year: "2026",
  pages: "100",
  language: "English",
  size: "1 KB",
  extension: "epub",
  mirror: `/ads.php?md5=${md5}`,
});

const installNetworkFixture = () => {
  const requestedURLs: string[] = [];
  const fixtureFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = getRequestURL(input);
      requestedURLs.push(url);

      if (url.includes("/ads.php?md5=success")) {
        return new Response(
          '<table id="main"><tr><td>Book</td><td><a href="/files/success.epub">GET</a></td></tr></table>'
        );
      }

      if (url.includes("/ads.php?md5=missing")) {
        return new Response("<main>Download link unavailable</main>");
      }

      if (url.endsWith("/files/success.epub")) {
        return new Response("downloaded content", {
          headers: {
            "content-disposition": 'attachment; filename="success.epub"',
            "content-length": "18",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    { preconnect() {} }
  );
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fixtureFetch);

  return { fetchMock, requestedURLs };
};

const installFilesystemFixture = () => {
  const downloadedChunks: Buffer[] = [];
  const createWriteStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        downloadedChunks.push(Buffer.from(chunk));
        callback();
      },
    }) as fs.WriteStream;
  });
  const writeFile = spyOn(fs.promises, "writeFile").mockImplementation(async () => {});

  return { createWriteStream, downloadedChunks, writeFile };
};

beforeEach(() => {
  useBoundStore.setState(
    {
      ...originalStoreState,
      ...initialAppState,
      ...initialConfigState,
      ...initialDownloadQueueState,
      ...initialBulkDownloadQueueState,
      CLIMode: false,
      mirror: { src: BASE_URL, type: "libgen-plus" },
      mirrorAdapter: new LibgenPlusAdapter(BASE_URL),
      outputDirectory: OUTPUT_DIRECTORY,
      setWarningMessage: mock(() => {}),
    },
    true
  );
});

afterEach(() => {
  mock.restore();
  useBoundStore.setState(originalStoreState, true);
});

describe("download queue integration", () => {
  it("deduplicates entries before starting the queue", () => {
    const iterateQueue = mock(async () => {});
    useBoundStore.setState({ iterateQueue });
    const entry = createEntry("entry-1", "success");

    useBoundStore.getState().pushDownloadQueue(entry);
    useBoundStore.getState().pushDownloadQueue(entry);

    const state = useBoundStore.getState();
    expect(state.downloadQueue).toEqual([entry]);
    expect(state.inDownloadQueueEntryIds).toEqual([entry.id]);
    expect(state.totalAddedToDownloadQueue).toBe(1);
    expect(state.downloadProgressMap[entry.id]?.status).toBe(DownloadStatus.IN_QUEUE);
    expect(iterateQueue).toHaveBeenCalledTimes(1);
  });

  it("resolves a mirror page, downloads the file, and completes the queue item", async () => {
    const { fetchMock, requestedURLs } = installNetworkFixture();
    const { createWriteStream, downloadedChunks } = installFilesystemFixture();
    const entry = createEntry("entry-1", "success");
    useBoundStore.setState({
      downloadQueue: [entry],
      inDownloadQueueEntryIds: [entry.id],
    });

    await useBoundStore.getState().iterateQueue();

    const state = useBoundStore.getState();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedURLs).toEqual([
      "https://libgen.example/ads.php?md5=success",
      "https://libgen.example/files/success.epub",
    ]);
    expect(createWriteStream).toHaveBeenCalledWith(path.join(OUTPUT_DIRECTORY, "success.epub"));
    expect(Buffer.concat(downloadedChunks).toString()).toBe("downloaded content");
    expect(state.downloadProgressMap[entry.id]).toMatchObject({
      filename: "success.epub",
      progress: 18,
      total: 18,
      status: DownloadStatus.DOWNLOADED,
    });
    expect(state.totalDownloaded).toBe(1);
    expect(state.totalFailed).toBe(0);
    expect(state.inDownloadQueueEntryIds).toEqual([]);
    expect(state.isQueueActive).toBe(false);
  });
});

describe("bulk download integration", () => {
  it("builds a bulk queue from selected entries before processing", async () => {
    const operateBulkDownloadQueue = mock(async () => {});
    const validEntry = createEntry("entry-1", "success");
    const invalidEntry = { ...createEntry("entry-2", "missing"), mirror: "/ads.php" };
    useBoundStore.setState({
      CLIMode: true,
      bulkDownloadSelectedEntries: {
        valid: validEntry,
        invalid: invalidEntry,
      },
      operateBulkDownloadQueue,
    });

    await useBoundStore.getState().startBulkDownload();

    const state = useBoundStore.getState();
    expect(state.bulkDownloadQueue).toEqual([
      {
        md5: "success",
        filename: "",
        total: 0,
        progress: 0,
        status: DownloadStatus.IN_QUEUE,
      },
    ]);
    expect(operateBulkDownloadQueue).toHaveBeenCalledTimes(1);
  });

  it("processes successful and failed items and records only completed MD5s", async () => {
    const { fetchMock } = installNetworkFixture();
    const { downloadedChunks, writeFile } = installFilesystemFixture();
    useBoundStore.setState({
      bulkDownloadQueue: [
        {
          md5: "success",
          filename: "",
          total: 0,
          progress: 0,
          status: DownloadStatus.IN_QUEUE,
        },
        {
          md5: "missing",
          filename: "",
          total: 0,
          progress: 0,
          status: DownloadStatus.IN_QUEUE,
        },
      ],
    });

    await useBoundStore.getState().operateBulkDownloadQueue();

    const state = useBoundStore.getState();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.bulkDownloadQueue).toMatchObject([
      {
        md5: "success",
        filename: "success.epub",
        progress: 18,
        total: 18,
        status: DownloadStatus.DOWNLOADED,
      },
      {
        md5: "missing",
        status: DownloadStatus.FAILED,
      },
    ]);
    expect(Buffer.concat(downloadedChunks).toString()).toBe("downloaded content");
    expect(state.completedBulkDownloadItemCount).toBe(1);
    expect(state.failedBulkDownloadItemCount).toBe(1);
    expect(state.isBulkDownloadComplete).toBe(true);
    expect(state.createdMD5ListFileName).toMatch(/^libgen_downloader_md5_list_\d+\.txt$/);
    expect(writeFile.mock.calls[0]?.[0].toString()).toBe(
      path.join(OUTPUT_DIRECTORY, state.createdMD5ListFileName)
    );
    expect(writeFile.mock.calls[0]?.[1]).toBe(`# mirror: ${BASE_URL}\nsuccess`);

    // The failed item is written to its own file, ready to feed back to -b.
    expect(state.createdFailureListFileName).toMatch(/^libgen_downloader_failed_\d+\.txt$/);
    expect(writeFile.mock.calls[1]?.[1]).toContain("missing\tnot found on any mirror");
  });

  it("records why an item failed instead of leaving a bare FAILED row", async () => {
    installNetworkFixture();
    installFilesystemFixture();
    useBoundStore.setState({
      bulkDownloadQueue: [
        {
          md5: "missing",
          filename: "",
          total: 0,
          progress: 0,
          status: DownloadStatus.IN_QUEUE,
        },
      ],
    });

    await useBoundStore.getState().operateBulkDownloadQueue();

    const item = useBoundStore.getState().bulkDownloadQueue[0];
    expect(item?.status).toBe(DownloadStatus.FAILED);
    expect(item?.error).toBe("not found on any mirror (libgen.example)");
  });

  it("falls back to another mirror and prefers it for the rest of the run", async () => {
    const SECOND_URL = "https://second.example/";
    const firstMD5 = "b7abef3d085a1007a137a247dcff8dcb";
    const secondMD5 = "108804c7a0e8c28c31071f2c34269570";
    const { requestedURLs } = mockFetch(async (input) => {
      const url = getRequestURL(input);

      if (url.startsWith(SECOND_URL) && url.includes("/ads.php")) {
        return new Response(
          '<table id="main"><tr><td>Book</td><td><a href="/files/book.epub">GET</a></td></tr></table>'
        );
      }

      if (url.startsWith(SECOND_URL)) {
        return new Response("downloaded content", {
          headers: {
            "content-disposition": 'attachment; filename="book.epub"',
            "content-length": "18",
          },
        });
      }

      // The active mirror simply doesn't carry these records.
      return new Response("<html>no record</html>");
    });
    const { writeFile } = installFilesystemFixture();

    useBoundStore.setState({
      mirrors: [
        { src: BASE_URL, type: "libgen-plus" },
        { src: SECOND_URL, type: "libgen-plus" },
      ],
      bulkDownloadQueue: [firstMD5, secondMD5].map((md5) => ({
        md5,
        filename: "",
        total: 0,
        progress: 0,
        status: DownloadStatus.IN_QUEUE,
      })),
    });

    await useBoundStore.getState().operateBulkDownloadQueue();

    const state = useBoundStore.getState();
    expect(state.completedBulkDownloadItemCount).toBe(2);
    expect(state.failedBulkDownloadItemCount).toBe(0);
    expect(state.bulkDownloadQueue.map((item) => item.mirror)).toEqual([SECOND_URL, SECOND_URL]);
    expect(state.preferredMirrorSource).toBe(SECOND_URL);
    // The second item skips the mirror that already came up empty.
    expect(requestedURLs).toEqual([
      `${BASE_URL}ads.php?md5=${firstMD5}`,
      `${SECOND_URL}ads.php?md5=${firstMD5}`,
      `${SECOND_URL}files/book.epub`,
      `${SECOND_URL}ads.php?md5=${secondMD5}`,
      `${SECOND_URL}files/book.epub`,
    ]);
    expect(writeFile.mock.calls[0]?.[1]).toBe(`# mirror: ${SECOND_URL}\n${firstMD5}\n${secondMD5}`);
  });
});
