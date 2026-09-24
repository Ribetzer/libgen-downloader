import {
  DOIMetadata,
  fetchCrossrefBatch,
  fetchCSL,
  isBatchableDOI,
} from "../api/data/doi-metadata";
import { METADATA_BATCH_SIZE, METADATA_REQUEST_INTERVAL_MS, METADATA_RETRY_MS } from "../settings";
import { ItemStore, QueueItem } from "./database";

interface MetadataServiceArguments {
  store: ItemStore;
  /** Told about every batch of rows that got their metadata. */
  onUpdated: (items: QueueItem[]) => void;
  /**
   * An address to put in the User-Agent. Crossref serves requests that carry
   * one from its "polite" pool, which is faster and less aggressively limited.
   */
  contact?: string;
  requestIntervalMs?: number;
  retryMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks up the title, authors and venue of every DOI queued from an uploaded
 * list, in the background and independently of the download queue: a list is
 * readable within a minute of dropping it, rather than one row at a time as
 * each download comes round.
 *
 * Nothing here decides what gets downloaded. A DOI no source knows is recorded
 * as `missing`, which is itself worth seeing - it is usually a typo in the list.
 */
export class MetadataService {
  private store: ItemStore;
  private onUpdated: (items: QueueItem[]) => void;
  private userAgent: string;
  private requestIntervalMs: number;
  private retryMs: number;
  private running = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor({ store, onUpdated, contact, requestIntervalMs, retryMs }: MetadataServiceArguments) {
    this.store = store;
    this.onUpdated = onUpdated;
    this.requestIntervalMs = requestIntervalMs ?? METADATA_REQUEST_INTERVAL_MS;
    this.retryMs = retryMs ?? METADATA_RETRY_MS;

    this.userAgent = "libgen-downloader (https://github.com/obsfx/libgen-downloader)";
    if (contact) {
      this.userAgent += ` (mailto:${contact})`;
    }
  }

  /** Safe to call at any time; a second call while working does nothing. */
  wake(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.run().finally(() => {
      this.running = false;
    });
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.wake();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private async run(): Promise<void> {
    for (;;) {
      const pending = this.store.listNeedingMetadata(METADATA_BATCH_SIZE);
      if (pending.length === 0) {
        return;
      }

      const finished = await this.lookUp(pending);
      if (!finished) {
        this.scheduleRetry();
        return;
      }

      await sleep(this.requestIntervalMs);
    }
  }

  /**
   * One batch. Returns false when a source could not be reached, leaving the
   * rows not yet answered pending for the retry - a network failure says
   * nothing about whether a DOI exists.
   */
  private async lookUp(pending: QueueItem[]): Promise<boolean> {
    const batchable = pending.map((item) => item.doi).filter((doi) => isBatchableDOI(doi));
    const fromCrossref = await fetchCrossrefBatch(batchable, this.userAgent);
    if (!fromCrossref) {
      return false;
    }

    const updated: QueueItem[] = [];
    const record = (item: QueueItem, meta: DOIMetadata) => {
      this.store.setMetadata(item.id, meta);
      const refreshed = this.store.get(item.id);
      if (refreshed) {
        updated.push(refreshed);
      }
    };

    // Crossref's answers first, in one go, so most of a list fills in at once.
    const unanswered: QueueItem[] = [];
    for (const item of pending) {
      const meta = fromCrossref.get(item.doi.toLowerCase());
      if (meta) {
        record(item, meta);
      } else {
        unanswered.push(item);
      }
    }
    this.onUpdated(updated.splice(0));

    let reachable = true;
    for (const item of unanswered) {
      await sleep(this.requestIntervalMs);
      const meta = await fetchCSL(item.doi, this.userAgent);
      if (!meta) {
        reachable = false;
        break;
      }

      record(item, meta);
    }
    this.onUpdated(updated);

    return reachable;
  }
}
