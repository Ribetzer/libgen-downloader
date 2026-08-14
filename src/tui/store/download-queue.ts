import { TCombinedStore } from "./index";
import { Entry } from "../../api/models/entry";
import { DownloadStatus } from "../../download-statuses";
import { downloadByMD5 } from "../../api/data/download";
import { getMD5FromURL } from "../../api/data/md5";

export interface IDownloadProgress {
  filename: string;
  total: number;
  progress: number | undefined;
  status: DownloadStatus;
}

export interface IDownloadQueueState {
  downloadQueue: Entry[];
  inDownloadQueueEntryIds: string[];
  downloadProgressMap: Record<string, IDownloadProgress>;
  totalAddedToDownloadQueue: number;
  totalDownloaded: number;
  totalFailed: number;
  isQueueActive: boolean;

  pushDownloadQueue: (entry: Entry) => void;
  consumeDownloadQueue: () => Entry | undefined;
  removeEntryIdFromDownloadQueue: (entryId: string) => void;
  iterateQueue: () => Promise<void>;
  updateCurrentDownloadProgress: (
    entryId: string,
    downloadProgress: Partial<IDownloadProgress>
  ) => void;
  increaseTotalAddedToDownloadQueue: () => void;
  increaseTotalDownloaded: () => void;
  increaseTotalFailed: () => void;
}

export const initialDownloadQueueState = {
  downloadQueue: [],
  inDownloadQueueEntryIds: [],
  downloadProgressMap: {},
  totalAddedToDownloadQueue: 0,
  totalDownloaded: 0,
  totalFailed: 0,
  isQueueActive: false,
};

export const createDownloadQueueStateSlice = (
  set: (
    partial: Partial<TCombinedStore> | ((state: TCombinedStore) => Partial<TCombinedStore>)
  ) => void,
  get: () => TCombinedStore
) => ({
  ...initialDownloadQueueState,

  pushDownloadQueue: (entry: Entry) => {
    const store = get();

    if (store.inDownloadQueueEntryIds.includes(entry.id)) {
      return;
    }

    set({
      downloadQueue: [...store.downloadQueue, entry],
      inDownloadQueueEntryIds: [...store.inDownloadQueueEntryIds, entry.id],
    });

    store.updateCurrentDownloadProgress(entry.id, {
      filename: "",
      progress: 0,
      total: 0,
      status: DownloadStatus.IN_QUEUE,
    });

    store.increaseTotalAddedToDownloadQueue();

    if (store.isQueueActive) {
      return;
    }

    store.iterateQueue();
  },

  consumeDownloadQueue: () => {
    const store = get();

    if (store.downloadQueue.length === 0) {
      return;
    }

    const entry = store.downloadQueue[0];

    set({
      downloadQueue: store.downloadQueue.slice(1),
    });

    return entry;
  },

  removeEntryIdFromDownloadQueue: (entryId: string) => {
    const store = get();
    set({
      inDownloadQueueEntryIds: store.inDownloadQueueEntryIds.filter((id) => id !== entryId),
    });
  },

  iterateQueue: async () => {
    const store = get();

    set({ isQueueActive: true });

    try {
      for (;;) {
        const entry = store.consumeDownloadQueue();
        if (!entry) {
          break;
        }

        try {
          store.updateCurrentDownloadProgress(entry.id, {
            status: DownloadStatus.CONNECTING_TO_LIBGEN,
          });

          const detailPageUrl = store.mirrorAdapter?.getPageURL(entry.mirror);
          const md5 = detailPageUrl && getMD5FromURL(detailPageUrl);
          if (!md5) {
            store.setWarningMessage(`Couldn't find the MD5 for "${entry.title}"`);
            store.increaseTotalFailed();
            store.updateCurrentDownloadProgress(entry.id, {
              status: DownloadStatus.FAILED,
            });
            continue;
          }

          store.updateCurrentDownloadProgress(entry.id, {
            status: DownloadStatus.DOWNLOADING,
          });

          const outcome = await downloadByMD5({
            md5,
            candidates: store.getMirrorCandidates(),
            outputDirectory: store.outputDirectory,
            onStart: (filename, total) => {
              store.updateCurrentDownloadProgress(entry.id, {
                filename,
                progress: 0,
                total,
              });
            },
            onProgress: (filename, receivedBytes, total) => {
              store.updateCurrentDownloadProgress(entry.id, {
                filename,
                progress: receivedBytes,
                total,
              });
            },
            onMirrorUnreachable: (mirrorSource) => {
              store.markMirrorUnreachable(mirrorSource);
            },
            onRetry: () => {
              store.updateCurrentDownloadProgress(entry.id, {
                progress: 0,
                status: DownloadStatus.RETRYING,
              });
            },
          });

          if (outcome.status === "failed") {
            store.setWarningMessage(`Couldn't download "${entry.title}": ${outcome.reason}`);
            store.increaseTotalFailed();
            store.updateCurrentDownloadProgress(entry.id, {
              status: DownloadStatus.FAILED,
            });
            continue;
          }

          store.setPreferredMirrorSource(outcome.mirror.src);
          store.increaseTotalDownloaded();

          let finalStatus = DownloadStatus.DOWNLOADED;
          if (outcome.result.skipped) {
            finalStatus = DownloadStatus.SKIPPED;
          }

          store.updateCurrentDownloadProgress(entry.id, {
            status: finalStatus,
          });
        } finally {
          store.removeEntryIdFromDownloadQueue(entry.id);
        }
      }
    } finally {
      // A queue that never clears this flag would refuse every later download.
      set({ isQueueActive: false });
    }
  },

  updateCurrentDownloadProgress: (
    entryId: string,
    downloadProgress: Partial<IDownloadProgress>
  ) => {
    // `progress` is the byte count for the current attempt, so it is assigned
    // rather than accumulated and a restart simply reports lower numbers.
    set((previous) => ({
      downloadProgressMap: {
        ...previous.downloadProgressMap,
        [entryId]: {
          ...previous.downloadProgressMap[entryId],
          ...downloadProgress,
        },
      },
    }));
  },

  increaseTotalAddedToDownloadQueue: () => {
    set((previous) => ({
      totalAddedToDownloadQueue: previous.totalAddedToDownloadQueue + 1,
    }));
  },

  increaseTotalDownloaded: () => {
    set((previous) => ({
      totalDownloaded: previous.totalDownloaded + 1,
    }));
  },

  increaseTotalFailed: () => {
    set((previous) => ({
      totalFailed: previous.totalFailed + 1,
    }));
  },
});
