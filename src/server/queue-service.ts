import { downloadByMD5, downloadFromURL } from "../api/data/download";
import type { DownloadResult } from "../api/models/download-result";
import { downloadRequestInit } from "../api/sources";
import { QUEUE_RETRY_MS } from "../settings";
import { ItemStore, NewQueueItem, QueueItem, TERMINAL_STATUSES } from "./database";
import { MirrorService } from "./mirror-service";
import { StorageService } from "./storage-service";

export type QueueEvent =
  | { type: "item-added"; item: QueueItem }
  | { type: "item-updated"; item: QueueItem }
  // Rows that changed without their status changing - a title and authors
  // arriving for listed DOIs. Sent in batches, and handled by the browser as
  // an in-place merge, so thousands of them do not trigger thousands of reloads.
  | { type: "items-refreshed"; items: QueueItem[] }
  | { type: "queue-idle" };

type Listener = (event: QueueEvent) => void;

interface QueueServiceArguments {
  store: ItemStore;
  mirrors: MirrorService;
  outputDirectory: string;
  storage?: StorageService;
  retryMs?: number;
  /** Called once per item reaching a terminal state, for notifying elsewhere. */
  onFinished?: (item: QueueItem) => void;
  /** Looks up a DOI-only item when its turn comes; see `lookUpDOI`. */
  resolveDOI?: (doi: string) => Promise<NewQueueItem | { reason: string }>;
}

/**
 * Drains the queue one item at a time through `downloadByMD5`, which owns
 * resolve, retry, mirror fall-through and cleanup. This layer only decides what
 * to work on next, records the outcome, and tells listeners about it.
 *
 * Sequential on purpose: the 429/503 backoff exists because the mirrors
 * throttle, and running several transfers at once invites exactly that.
 */
export class QueueService {
  private store: ItemStore;
  private mirrors: MirrorService;
  private outputDirectory: string;
  private storage: StorageService | undefined;
  private listeners = new Set<Listener>();
  private running = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs: number;
  private onFinished: ((item: QueueItem) => void) | undefined;
  private resolveDOI: QueueServiceArguments["resolveDOI"];

  constructor({
    store,
    mirrors,
    outputDirectory,
    storage,
    retryMs,
    onFinished,
    resolveDOI,
  }: QueueServiceArguments) {
    this.store = store;
    this.mirrors = mirrors;
    this.outputDirectory = outputDirectory;
    this.storage = storage;
    this.retryMs = retryMs ?? QUEUE_RETRY_MS;
    this.onFinished = onFinished;
    this.resolveDOI = resolveDOI;
  }

  /**
   * Comes back to work that is still queued. Without this the queue would wait
   * on whoever else calls `start()`, and the server's config refresh backs off
   * to hourly once everything is healthy - so a disk unplugged and replugged in
   * between would leave the queue parked for the rest of that hour.
   */
  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, this.retryMs);

    this.retryTimer.unref?.();
  }

  /** Stops the retry timer; for tests and a clean shutdown. */
  dispose(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private publish(id: number, type: "item-added" | "item-updated"): void {
    const item = this.store.get(id);
    if (item) {
      this.emit({ type, item });
    }
  }

  private change(id: number, changes: Partial<QueueItem>): void {
    this.store.update(id, changes);
    this.publish(id, "item-updated");
  }

  /**
   * Queue a file, reusing its row when there is one to reuse: one already
   * waiting or in flight is returned as-is, and one that failed or was
   * cancelled goes back in the queue. A file already downloaded gets a new row
   * - the disk, not the history, decides whether it is still there.
   */
  add(entry: NewQueueItem): QueueItem {
    const existing = this.store.findByIdentity(entry.md5, entry.url, entry.doi);
    if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
      return existing;
    }

    if (existing && (existing.status === "failed" || existing.status === "cancelled")) {
      // Whoever queued it this time may know more than the first caller did.
      this.store.update(existing.id, {
        title: existing.title || entry.title || undefined,
        doi: existing.doi || entry.doi || undefined,
        url: existing.url || entry.url || undefined,
        origin: existing.origin || entry.origin || undefined,
      });
      this.retry(existing.id);
      return this.store.get(existing.id) as QueueItem;
    }

    const item = this.store.add(entry);
    this.emit({ type: "item-added", item });
    this.start();
    return item;
  }

  addMany(entries: NewQueueItem[]): QueueItem[] {
    return entries.map((entry) => this.add(entry));
  }

  /** Tell listeners that these rows changed in place; see `items-refreshed`. */
  refreshed(items: QueueItem[]): void {
    if (items.length > 0) {
      this.emit({ type: "items-refreshed", items });
    }
  }

  /** Put a failed or cancelled item back in the queue as the same row. */
  retry(id: number): boolean {
    const retried = this.store.requeue(id);
    if (retried) {
      this.publish(id, "item-updated");
      this.start();
    }

    return retried;
  }

  cancel(id: number): boolean {
    const cancelled = this.store.cancel(id);
    if (cancelled) {
      this.publish(id, "item-updated");
    }

    return cancelled;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Safe to call at any time; a second call while draining does nothing. */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      this.emit({ type: "queue-idle" });
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const item = this.store.takeNextQueued();
      if (!item) {
        return;
      }

      // With no mirror there is nothing to try, and failing every item for a
      // VPN that is still connecting would be wrong. Leave the queue as it is
      // and come back to it.
      //
      // Only for an item that actually needs a mirror: an arXiv or Sci-Hub row
      // carries its own URL and has no reason to wait on LibGen being up.
      if (!item.url && this.mirrors.getCandidates().length === 0) {
        this.scheduleRetry();
        return;
      }

      // Same reasoning one step later: with the output volume unplugged there
      // is nowhere to write, and an unplugged cable must not fail a queue.
      if (this.storage && !(await this.storage.isReady())) {
        this.scheduleRetry();
        return;
      }

      await this.process(item);
      this.announceFinished(item.id);
    }
  }

  /**
   * Tells a listener the item is done with, whatever the outcome. Kept out of
   * `process` so a slow or broken listener cannot interfere with the download
   * itself, and errors here are swallowed for the same reason.
   */
  private announceFinished(id: number): void {
    if (!this.onFinished) {
      return;
    }

    const item = this.store.get(id);
    if (!item) {
      return;
    }

    try {
      this.onFinished(item);
    } catch {
      // A notification failing must not stop the queue draining.
    }
  }

  private async process(queued: QueueItem): Promise<void> {
    this.change(queued.id, { status: "resolving", error: "", progress: 0 });

    let item: QueueItem | undefined = queued;
    if (!queued.md5 && !queued.url && queued.doi) {
      item = await this.lookUpDOI(queued);
    }

    if (item) {
      await this.transfer(item);
    }
  }

  /**
   * An item queued by DOI alone is looked up here, when its turn comes, rather
   * than when it was queued: a list of two thousand DOIs then queues at once,
   * the lookups keep the same one-at-a-time pace as the downloads, and a DOI
   * no source holds becomes an ordinary failed row that can be retried.
   */
  private async lookUpDOI(item: QueueItem): Promise<QueueItem | undefined> {
    if (!this.resolveDOI) {
      this.change(item.id, { status: "failed", error: "no DOI lookup available" });
      return;
    }

    const resolved = await this.resolveDOI(item.doi);
    if ("reason" in resolved) {
      this.change(item.id, { status: "failed", error: resolved.reason });
      return;
    }

    this.change(item.id, {
      md5: resolved.md5 || undefined,
      url: resolved.url || undefined,
      source: resolved.source || undefined,
      // The DOI's own registered title beats a library's catalogue entry for
      // naming the file, when the metadata lookup has already found it.
      title: item.title || item.meta?.title || resolved.title || undefined,
    });
    return this.store.get(item.id);
  }

  private async transfer(item: QueueItem): Promise<void> {
    // The callbacks are the same whichever route the file takes; only the way
    // its location is worked out differs.
    const shared = {
      outputDirectory: this.outputDirectory,
      // Whoever queued this usually knows the real title - a DOI lookup
      // certainly does - and libgen's own filename often does not.
      preferredTitle: item.title,
      // Written into the filename when the source's own name carries no DOI,
      // which is how the identifier reaches the RAG: `paper_id` decodes
      // `[10.1007_978-3-030-31154-4]` straight out of the name. It matters
      // most for Sci-Hub, where the DOI is how the file was found at all.
      preferredDOI: item.doi,
      onStart: (filename: string, total: number) => {
        this.change(item.id, { status: "downloading", filename, total, progress: 0 });
      },
      onProgress: (filename: string, receivedBytes: number, total: number) => {
        this.change(item.id, { filename, progress: receivedBytes, total });
      },
      onRetry: (message: string) => {
        this.change(item.id, { status: "retrying", error: message, progress: 0 });
      },
    };

    // A URL is a location, an MD5 is a record to look one up for. Which of the
    // two an item carries is decided by the source it came from.
    if (item.url) {
      const outcome = await downloadFromURL({
        downloadURL: item.url,
        // Whatever the host needs to be fetched at all - the Sci-Hub pin, for
        // a PDF served from the page host rather than the storage one.
        requestInit: downloadRequestInit(item.url),
        ...shared,
      });

      if (outcome.status === "failed") {
        this.change(item.id, { status: "failed", error: outcome.reason });
        return;
      }

      this.finish(item.id, outcome.result, item.source);
      return;
    }

    const outcome = await downloadByMD5({
      md5: item.md5,
      candidates: this.mirrors.getCandidates(),
      onMirrorUnreachable: (mirrorSource) => {
        this.mirrors.markUnreachable(mirrorSource);
      },
      ...shared,
    });

    if (outcome.status === "failed") {
      this.change(item.id, { status: "failed", error: outcome.reason });
      return;
    }

    this.mirrors.notePreferred(outcome.mirror.src);
    this.finish(item.id, outcome.result, outcome.mirror.src);
  }

  /** Records a completed download, whichever route produced it. */
  private finish(id: number, result: DownloadResult, mirror: string): void {
    let status: QueueItem["status"] = "downloaded";
    if (result.skipped) {
      status = "skipped";
    }

    this.change(id, {
      status,
      error: "",
      filename: result.filename,
      mirror,
      total: result.total,
      progress: result.total,
    });
  }
}
