import { downloadByMD5, DownloadLane, downloadFromURL } from "../api/data/download";
import { DEFAULT_ANNAS_DOMAIN, fetchAnnasDownloadURL } from "../api/sources/annas-archive";
import { DIRECT_LANE } from "../api/data/libgen-file-pacing";
import type { DownloadResult } from "../api/models/download-result";
import { downloadRequestInit } from "../api/sources";
import { DEFER_SCHEDULE_MS, QUEUE_RETRY_MS } from "../settings";
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
  /** How many items are worked on at once; 1 when not given. */
  concurrency?: number;
  /**
   * The ways out to LibGen, one per VPN connection. Workers are spread across
   * them. The process's own connection alone when not given.
   */
  lanes?: DownloadLane[];
  /** Whether a lane can be used right now; every lane is when not given. */
  isLaneReady?: (lane: DownloadLane) => boolean;
  /** Told when LibGen could not be reached at all through a proxied lane. */
  onLaneTrouble?: (lane: DownloadLane) => void;
  /** Called once per item reaching a terminal state, for notifying elsewhere. */
  onFinished?: (item: QueueItem) => void;
  /** Looks up a DOI-only item when its turn comes; see `lookUpDOI`. */
  resolveDOI?: (
    doi: string,
    lane?: DownloadLane
  ) => Promise<NewQueueItem | { reason: string; transient?: boolean }>;
  /** Waits before a transient failure is tried again; see DEFER_SCHEDULE_MS. */
  deferScheduleMs?: number[];
  /**
   * An Anna's Archive member key, to fetch by MD5 from its fast servers when
   * LibGen cannot deliver a file. Unset means the fallback is off.
   */
  annasKey?: string;
  annasDomain?: string;
}

/**
 * Drains the queue through `downloadByMD5`, which owns resolve, retry, mirror
 * fall-through and cleanup. This layer only decides what to work on next,
 * records the outcome, and tells listeners about it.
 *
 * Several items at once, each by its own worker. It used to be strictly one
 * at a time, on the theory that parallel transfers provoke the mirrors'
 * throttling. The throttle that actually bites is LibGen's CDN allowing 15
 * files per 300s per IP - a count of *starts*, which `paceLibgenFile` spaces
 * whatever the concurrency - while the same CDN serves each connection at a
 * few tens of KB/s. Measured, three connections moved roughly three times the
 * bytes of one; and one sequential worker left a 400 MB book holding up two
 * thousand small papers behind it.
 */
export class QueueService {
  private store: ItemStore;
  private mirrors: MirrorService;
  private outputDirectory: string;
  private storage: StorageService | undefined;
  private listeners = new Set<Listener>();
  private workers = 0;
  private concurrency: number;
  private lanes: DownloadLane[];
  private laneWorkers = new Map<string, number>();
  private isLaneReady: (lane: DownloadLane) => boolean;
  private onLaneTrouble: ((lane: DownloadLane) => void) | undefined;
  /** Counts `start()` calls; see `work`. */
  private requests = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs: number;
  private onFinished: ((item: QueueItem) => void) | undefined;
  private resolveDOI: QueueServiceArguments["resolveDOI"];
  private deferScheduleMs: number[];
  private annasKey: string;
  private annasDomain: string;
  /** Anna's said the key can fetch nothing more today: leave it until then. */
  private annasPausedUntil = 0;

  constructor({
    store,
    mirrors,
    outputDirectory,
    storage,
    retryMs,
    concurrency,
    lanes,
    isLaneReady,
    onLaneTrouble,
    onFinished,
    resolveDOI,
    deferScheduleMs,
    annasKey,
    annasDomain,
  }: QueueServiceArguments) {
    this.concurrency = Math.max(1, concurrency ?? 1);
    this.lanes = [{ key: DIRECT_LANE }];
    if (lanes && lanes.length > 0) {
      this.lanes = lanes;
    }
    this.isLaneReady = isLaneReady ?? (() => true);
    this.onLaneTrouble = onLaneTrouble;
    this.store = store;
    this.mirrors = mirrors;
    this.outputDirectory = outputDirectory;
    this.storage = storage;
    this.retryMs = retryMs ?? QUEUE_RETRY_MS;
    this.onFinished = onFinished;
    this.resolveDOI = resolveDOI;
    this.deferScheduleMs = deferScheduleMs ?? DEFER_SCHEDULE_MS;
    this.annasKey = annasKey ?? "";
    this.annasDomain = annasDomain || DEFAULT_ANNAS_DOMAIN;
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

  /**
   * Trouble that says nothing about the file - an overloaded server, dropped
   * connections, a captcha - puts the item back to wait, for longer each time,
   * instead of failing it: retrying at once cannot outlast an outage measured
   * in hours, and it used to turn a busy evening into a page of failures.
   * Once the waits are used up it fails, saying how long it was given.
   */
  private deferOrFail(id: number, reason: string): void {
    const deferrals = this.store.get(id)?.deferrals ?? 0;
    const delayMs = this.deferScheduleMs[deferrals];
    if (delayMs === undefined) {
      const hours = this.deferScheduleMs.reduce((sum, ms) => sum + ms, 0) / 3_600_000;
      this.change(id, {
        status: "failed",
        error: `${reason} - still failing after being retried over ${Math.round(hours)} hours`,
      });
      return;
    }

    this.store.defer(id, delayMs, `${reason} - trying again later`);
    this.publish(id, "item-updated");
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
    return this.workers > 0;
  }

  /**
   * Safe to call at any time: tops the workers up to the concurrency, and does
   * nothing when they are all busy. `queue-idle` is sent when the last one
   * has nothing left to take.
   */
  start(): void {
    this.requests += 1;
    while (this.workers < this.concurrency) {
      const lane = this.quietestLane();
      if (!lane) {
        // Every lane is down. The lane check or the retry timer calls start()
        // again once one comes back.
        this.scheduleRetry();
        return;
      }

      this.workers += 1;
      this.laneWorkers.set(lane.key, (this.laneWorkers.get(lane.key) ?? 0) + 1);
      void this.work(lane).then((checkedAt) => {
        this.workers -= 1;
        this.laneWorkers.set(lane.key, (this.laneWorkers.get(lane.key) ?? 1) - 1);
        // Work queued between this worker finding nothing and it counting
        // itself out would otherwise wait: `start()` saw every slot taken
        // and started nobody. So a worker that ran dry takes another look.
        if (checkedAt !== undefined && checkedAt !== this.requests) {
          this.start();
          return;
        }

        if (this.workers === 0) {
          this.emit({ type: "queue-idle" });
        }
      });
    }
  }

  /**
   * One worker's loop. Resolves with the `start()` count at the moment it
   * found nothing to take, or `undefined` when it stopped for a reason that
   * more work would not change - no disk, or nothing it can fetch without a
   * mirror - in which case the retry timer brings it back.
   */
  /** The usable lane with the fewest workers, so the load spreads evenly. */
  private quietestLane(): DownloadLane | undefined {
    let quietest: DownloadLane | undefined;
    for (const lane of this.lanes) {
      if (!this.isLaneReady(lane)) {
        continue;
      }

      const load = this.laneWorkers.get(lane.key) ?? 0;
      if (!quietest || load < (this.laneWorkers.get(quietest.key) ?? 0)) {
        quietest = lane;
      }
    }

    return quietest;
  }

  private async work(lane: DownloadLane): Promise<number | undefined> {
    for (;;) {
      // A lane whose VPN connection has dropped hands its worker back, and
      // start() gives the slot to a lane that is up.
      if (!this.isLaneReady(lane)) {
        this.scheduleRetry();
        return undefined;
      }

      // With the output volume unplugged there is nowhere to write, and an
      // unplugged cable must not fail a queue. Leave it and come back.
      if (this.storage && !(await this.storage.isReady())) {
        this.scheduleRetry();
        return undefined;
      }

      // With no mirror, only a row carrying its own URL - arXiv, Sci-Hub - can
      // be fetched. The rest wait rather than fail for a VPN that is still
      // connecting. Claimed atomically, so no two workers take the same row.
      const withoutMirror = this.mirrors.getCandidates().length === 0;
      const checkedAt = this.requests;
      const item = this.store.claimNext(withoutMirror);
      if (!item) {
        if (withoutMirror && this.store.hasQueued()) {
          this.scheduleRetry();
        }
        return checkedAt;
      }

      await this.process(item, lane);
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

    // An item handed back to the queue is not done with.
    const item = this.store.get(id);
    if (!item || !TERMINAL_STATUSES.includes(item.status)) {
      return;
    }

    try {
      this.onFinished(item);
    } catch {
      // A notification failing must not stop the queue draining.
    }
  }

  private async process(queued: QueueItem, lane: DownloadLane): Promise<void> {
    this.change(queued.id, { status: "resolving", error: "", progress: 0 });

    let item: QueueItem | undefined = queued;
    if (!queued.md5 && !queued.url && queued.doi) {
      item = await this.lookUpDOI(queued, lane);
    }

    if (item) {
      await this.transfer(item, lane);
    }
  }

  /**
   * An item queued by DOI alone is looked up here, when its turn comes, rather
   * than when it was queued: a list of two thousand DOIs then queues at once,
   * the lookups keep the same one-at-a-time pace as the downloads, and a DOI
   * no source holds becomes an ordinary failed row that can be retried.
   */
  private async lookUpDOI(item: QueueItem, lane: DownloadLane): Promise<QueueItem | undefined> {
    if (!this.resolveDOI) {
      this.change(item.id, { status: "failed", error: "no DOI lookup available" });
      return;
    }

    const resolved = await this.resolveDOI(item.doi, lane);
    if ("reason" in resolved) {
      if (resolved.transient) {
        this.deferOrFail(item.id, resolved.reason);
        return;
      }

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

  private async transfer(item: QueueItem, lane: DownloadLane): Promise<void> {
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
        // The lane's proxy as well: a PDF on a Sci-Hub page host is behind the
        // same per-IP captcha as the lookup that found it.
        requestInit: { ...downloadRequestInit(item.url), proxy: lane.proxy },
        ...shared,
      });

      if (outcome.status === "failed" && outcome.transient) {
        this.deferOrFail(item.id, outcome.reason);
        return;
      }

      if (outcome.status === "failed") {
        this.change(item.id, { status: "failed", error: outcome.reason });
        return;
      }

      this.finish(item.id, outcome.result, item.source);
      return;
    }

    // A LibGen file goes out on this worker's lane. Its retry messages say
    // which, since each lane has an allowance - and a server - of its own.
    let laneNote = "";
    if (this.lanes.length > 1) {
      laneNote = `[${lane.key}] `;
    }
    const outcome = await downloadByMD5({
      md5: item.md5,
      lane,
      // With Anna's Archive to fall back on, LibGen gets a short try: its
      // download server drops transfers and restarts them from zero, and the
      // full patience spent most of an hour failing before the file was
      // fetched from Anna's in a minute. Full patience again once the day's
      // allowance is gone.
      quickTry: this.annasAvailable(),
      candidates: this.mirrors.getCandidates(),
      onMirrorUnreachable: (mirrorSource) => {
        this.mirrors.markUnreachable(mirrorSource);
      },
      ...shared,
      onRetry: (message: string) => {
        this.change(item.id, { status: "retrying", error: laneNote + message, progress: 0 });
      },
    });

    // LibGen could not deliver it. Anna's Archive holds its files under the
    // same MD5s on servers of its own, so a member key is a second way to
    // the same file before anything is deferred or failed.
    if (outcome.status === "failed" && (await this.fetchFromAnnas(item, lane, shared, laneNote))) {
      return;
    }

    // No mirror answered through a proxied lane: that is the lane, not the
    // file - LibGen answers a busy exit IP with 503s. Back in the queue for
    // another lane, and this one benched for a while.
    if (outcome.status === "failed" && outcome.unreachable && lane.proxy) {
      this.onLaneTrouble?.(lane);
      this.change(item.id, {
        status: "queued",
        error: `${laneNote}LibGen did not answer through this lane - back in the queue`,
        progress: 0,
      });
      return;
    }

    if (outcome.status === "failed" && outcome.transient) {
      this.deferOrFail(item.id, outcome.reason);
      return;
    }

    if (outcome.status === "failed") {
      this.change(item.id, { status: "failed", error: outcome.reason });
      return;
    }

    this.mirrors.notePreferred(outcome.mirror.src);
    this.finish(item.id, outcome.result, outcome.mirror.src);
  }

  /**
   * Fetch a LibGen file through Anna's Archive's member API instead. Resolves
   * true when that delivered it. Off without a key, and for the rest of the
   * UTC day once Anna's says the key has nothing left - so a day's allowance
   * running out costs one request, not one per failure.
   */
  /** Whether Anna's Archive can be asked right now: a key, and allowance left today. */
  private annasAvailable(): boolean {
    return Boolean(this.annasKey) && Date.now() >= this.annasPausedUntil;
  }

  private async fetchFromAnnas(
    item: QueueItem,
    lane: DownloadLane,
    shared: Omit<Parameters<typeof downloadFromURL>[0], "downloadURL">,
    laneNote: string
  ): Promise<boolean> {
    if (!this.annasAvailable() || !item.md5) {
      return false;
    }

    this.change(item.id, {
      status: "retrying",
      error: `${laneNote}LibGen could not deliver it - fetching from Anna's Archive`,
      progress: 0,
    });

    const link = await fetchAnnasDownloadURL(item.md5, this.annasKey, this.annasDomain, lane.proxy);
    if (link.status === "error") {
      if (link.exhausted) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        this.annasPausedUntil = tomorrow.getTime();
        console.log(`${link.message} - not asking again until ${tomorrow.toISOString()}`);
      }
      return false;
    }

    const outcome = await downloadFromURL({
      ...shared,
      downloadURL: link.downloadURL,
      requestInit: { proxy: lane.proxy },
      onRetry: (message: string) => {
        this.change(item.id, {
          status: "retrying",
          error: `${laneNote}Anna's Archive: ${message}`,
          progress: 0,
        });
      },
    });
    if (outcome.status !== "downloaded") {
      return false;
    }

    this.finish(item.id, outcome.result, `https://${this.annasDomain}/`);
    return true;
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
