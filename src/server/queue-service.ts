import { downloadByMD5 } from "../api/data/download";
import { ItemStore, QueueItem } from "./database";
import { MirrorService } from "./mirror-service";

export type QueueEvent =
  | { type: "item-added"; item: QueueItem }
  | { type: "item-updated"; item: QueueItem }
  | { type: "queue-idle" };

type Listener = (event: QueueEvent) => void;

interface QueueServiceArguments {
  store: ItemStore;
  mirrors: MirrorService;
  outputDirectory: string;
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
  private listeners = new Set<Listener>();
  private running = false;

  constructor({ store, mirrors, outputDirectory }: QueueServiceArguments) {
    this.store = store;
    this.mirrors = mirrors;
    this.outputDirectory = outputDirectory;
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

  add(md5: string, title = ""): QueueItem {
    const item = this.store.add(md5, title);
    this.emit({ type: "item-added", item });
    this.start();
    return item;
  }

  addMany(entries: { md5: string; title?: string }[]): QueueItem[] {
    return entries.map((entry) => this.add(entry.md5, entry.title || ""));
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

      await this.process(item);
    }
  }

  private async process(item: QueueItem): Promise<void> {
    this.change(item.id, { status: "resolving", error: "", progress: 0 });

    const outcome = await downloadByMD5({
      md5: item.md5,
      candidates: this.mirrors.getCandidates(),
      outputDirectory: this.outputDirectory,
      onStart: (filename, total) => {
        this.change(item.id, { status: "downloading", filename, total, progress: 0 });
      },
      onProgress: (filename, receivedBytes, total) => {
        this.change(item.id, { filename, progress: receivedBytes, total });
      },
      onMirrorUnreachable: (mirrorSource) => {
        this.mirrors.markUnreachable(mirrorSource);
      },
      onRetry: (message) => {
        this.change(item.id, { status: "retrying", error: message, progress: 0 });
      },
    });

    if (outcome.status === "failed") {
      this.change(item.id, { status: "failed", error: outcome.reason });
      return;
    }

    this.mirrors.notePreferred(outcome.mirror.src);

    let status: QueueItem["status"] = "downloaded";
    if (outcome.result.skipped) {
      status = "skipped";
    }

    this.change(item.id, {
      status,
      error: "",
      filename: outcome.result.filename,
      mirror: outcome.mirror.src,
      total: outcome.result.total,
      progress: outcome.result.total,
    });
  }
}
