import { Database } from "bun:sqlite";
import type { DOIMetadata } from "../api/data/doi-metadata";

export type ItemStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "retrying"
  | "downloaded"
  | "skipped"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ItemStatus[] = ["downloaded", "skipped", "failed", "cancelled"];

/** What a caller has to know to queue something. Everything else is filled in. */
export interface NewQueueItem {
  md5?: string;
  title?: string;
  doi?: string;
  source?: string;
  url?: string;
  /** How it was queued; "list" for an uploaded list. */
  origin?: string;
}

export interface QueueItem {
  id: number;
  /**
   * LibGen's identifier. Empty for a source that has none - arXiv and Sci-Hub
   * both name a file by URL instead, and `url` below carries it.
   */
  md5: string;
  title: string;
  /** Which library this came from; "libgen" for anything queued before sources existed. */
  source: string;
  /**
   * A direct download URL, when the source gave one. An item needs either this
   * or an `md5`: the first is fetched as-is, the second is resolved against
   * whichever mirror answers.
   */
  url: string;
  /**
   * The DOI this item was queued by, when it was. Kept because it is the only
   * unique identifier in the whole pipeline: the RAG's `paper_id` decodes
   * `[10.1080_10867651.2001...]` straight out of the filename, and a DOI is
   * what separates two volumes of one series that GROBID titles identically.
   * Resolving it to an MD5 and then dropping it lost that for good.
   */
  doi: string;
  /**
   * How the item was queued. "list" marks one from an uploaded list, which is
   * what gets a title/author lookup: a bare DOI says nothing about the paper.
   * Empty for everything else.
   */
  origin: string;
  /** What the DOI is, once looked up; absent while the lookup is pending. */
  meta?: DOIMetadata;
  status: ItemStatus;
  filename: string;
  mirror: string;
  error: string;
  progress: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

interface ItemRow {
  id: number;
  md5: string;
  title: string | null;
  source: string | null;
  url: string | null;
  doi: string | null;
  origin: string | null;
  meta: string | null;
  status: string;
  filename: string | null;
  mirror: string | null;
  error: string | null;
  progress: number | null;
  total: number | null;
  created_at: string;
  updated_at: string;
}

const parseMeta = (value: string | null): DOIMetadata | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as DOIMetadata;
  } catch {
    return undefined;
  }
};

const toQueueItem = (row: ItemRow): QueueItem => ({
  id: row.id,
  md5: row.md5,
  title: row.title || "",
  // Rows written before there was more than one library are LibGen's.
  source: row.source || "libgen",
  url: row.url || "",
  doi: row.doi || "",
  origin: row.origin || "",
  meta: parseMeta(row.meta),
  status: row.status as ItemStatus,
  filename: row.filename || "",
  mirror: row.mirror || "",
  error: row.error || "",
  progress: row.progress || 0,
  total: row.total || 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * One table holds both the queue and the history: history is simply the rows
 * that reached a terminal status.
 */
export class ItemStore {
  private database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        md5 TEXT NOT NULL,
        title TEXT,
        doi TEXT,
        status TEXT NOT NULL,
        filename TEXT,
        mirror TEXT,
        error TEXT,
        progress INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Added after the table existed, so an older database gets them here
    // rather than through a fresh CREATE. Duplicate-column is the expected
    // outcome on every run after the first.
    for (const column of ["doi TEXT", "source TEXT", "url TEXT", "origin TEXT", "meta TEXT"]) {
      try {
        this.database.run(`ALTER TABLE items ADD COLUMN ${column}`);
      } catch {
        // already applied
      }
    }
    this.database.run("CREATE INDEX IF NOT EXISTS items_status ON items (status)");
    // A row queued by DOI alone, before `origin` existed, can only have come
    // from an uploaded list: `POST /api/queue` looks a DOI up before adding it.
    this.database.run(
      `UPDATE items SET origin = 'list'
        WHERE origin IS NULL AND md5 = '' AND COALESCE(url, '') = '' AND COALESCE(doi, '') <> ''`
    );
  }

  /**
   * A container that was killed mid-download leaves rows claiming to be in
   * flight. The partial file was removed on the way down, or is complete and
   * will be skipped by the size check, so requeueing is safe.
   */
  recoverInterrupted(): number {
    const result = this.database.run(
      `UPDATE items
         SET status = 'queued', progress = 0, updated_at = datetime('now')
       WHERE status IN ('resolving', 'downloading', 'retrying')`
    );

    return result.changes;
  }

  add(entry: NewQueueItem): QueueItem {
    const row = this.database
      .query<ItemRow, [string, string, string, string, string, string]>(
        `INSERT INTO items (md5, title, source, url, doi, origin, status)
         VALUES (?, ?, ?, ?, ?, ?, 'queued') RETURNING *`
      )
      .get(
        entry.md5 || "",
        entry.title || "",
        entry.source || "libgen",
        entry.url || "",
        entry.doi || "",
        entry.origin || ""
      );

    return toQueueItem(row as ItemRow);
  }

  /** Anything still waiting or in flight, oldest first. */
  listActive(): QueueItem[] {
    return this.database
      .query<ItemRow, []>(
        `SELECT * FROM items
          WHERE status NOT IN ('downloaded', 'skipped', 'failed', 'cancelled')
          ORDER BY id ASC`
      )
      .all()
      .map((row) => toQueueItem(row));
  }

  listHistory(limit: number): QueueItem[] {
    return this.database
      .query<ItemRow, [number]>(
        `SELECT * FROM items
          WHERE status IN ('downloaded', 'skipped', 'failed', 'cancelled')
          ORDER BY updated_at DESC, id DESC
          LIMIT ?`
      )
      .all(limit)
      .map((row) => toQueueItem(row));
  }

  listFailed(): QueueItem[] {
    return this.database
      .query<ItemRow, []>("SELECT * FROM items WHERE status = 'failed' ORDER BY id ASC")
      .all()
      .map((row) => toQueueItem(row));
  }

  get(id: number): QueueItem | undefined {
    const row = this.database.query<ItemRow, [number]>("SELECT * FROM items WHERE id = ?").get(id);
    if (!row) {
      return;
    }

    return toQueueItem(row);
  }

  /** The next item to work on, or nothing when the queue is drained. */
  takeNextQueued(): QueueItem | undefined {
    const row = this.database
      .query<ItemRow, []>("SELECT * FROM items WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
      .get();

    if (!row) {
      return;
    }

    return toQueueItem(row);
  }

  update(
    id: number,
    changes: Partial<Omit<QueueItem, "id" | "createdAt" | "updatedAt" | "meta">>
  ): void {
    const assignments: string[] = [];
    const values: (string | number)[] = [];

    const columns: Record<string, string> = {
      md5: "md5",
      title: "title",
      doi: "doi",
      source: "source",
      url: "url",
      origin: "origin",
      status: "status",
      filename: "filename",
      mirror: "mirror",
      error: "error",
      progress: "progress",
      total: "total",
    };

    for (const [key, column] of Object.entries(columns)) {
      const value = changes[key as keyof typeof changes];
      if (value === undefined) {
        continue;
      }

      assignments.push(`${column} = ?`);
      values.push(value);
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push("updated_at = datetime('now')");
    this.database.run(`UPDATE items SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);
  }

  /**
   * The most recent row for the same file: the same MD5, or failing that the
   * same URL - the identity a search result is kept by - or, for an item
   * queued by DOI alone and not yet looked up, the same DOI. DOIs are
   * case-insensitive. A row with none of them matches nothing.
   */
  findByIdentity(md5?: string, url?: string, doi?: string): QueueItem | undefined {
    let condition = "lower(doi) = lower(?)";
    let value = doi;
    if (md5) {
      condition = "md5 = ?";
      value = md5;
    } else if (url) {
      condition = "url = ?";
      value = url;
    }

    if (!value) {
      return;
    }

    const row = this.database
      .query<ItemRow, [string]>(`SELECT * FROM items WHERE ${condition} ORDER BY id DESC LIMIT 1`)
      .get(value);
    if (!row) {
      return;
    }

    return toQueueItem(row);
  }

  /** Listed rows with a DOI whose title and authors have not been looked up yet. */
  listNeedingMetadata(limit: number): QueueItem[] {
    return this.database
      .query<ItemRow, [number]>(
        `SELECT * FROM items
          WHERE origin = 'list' AND COALESCE(doi, '') <> '' AND meta IS NULL
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(limit)
      .map((row) => toQueueItem(row));
  }

  /**
   * Record what a DOI turned out to be. Deliberately leaves `updated_at`
   * alone: history is ordered by it, and a lookup finishing is not something
   * that happened to the download.
   */
  setMetadata(id: number, meta: DOIMetadata): void {
    this.database.run("UPDATE items SET meta = ? WHERE id = ?", [JSON.stringify(meta), id]);
  }

  /**
   * Put a failed or cancelled row back in the queue, as the same row.
   *
   * Retrying used to insert a fresh row and leave the failure behind, still
   * failed. That stale row kept its Retry button, kept counting towards "Retry
   * all", and every "Retry all" queued it again - so one paper collected a
   * failure per attempt, even after another of its rows had downloaded it.
   */
  requeue(id: number): boolean {
    const result = this.database.run(
      `UPDATE items
          SET status = 'queued', error = '', progress = 0, total = 0, filename = '',
              mirror = '', updated_at = datetime('now')
        WHERE id = ? AND status IN ('failed', 'cancelled')`,
      [id]
    );

    return result.changes > 0;
  }

  /**
   * Remove one failed row from the history without retrying it.
   *
   * Deleted rather than marked: marking it `cancelled` kept it in the history
   * and, by touching `updated_at`, moved it to the top - above the row that had
   * since downloaded the same paper, where it read as that download cancelled.
   */
  dismiss(id: number): boolean {
    const result = this.database.run("DELETE FROM items WHERE id = ? AND status = 'failed'", [id]);

    return result.changes > 0;
  }

  /**
   * Clear out the failures that no longer stand for anything outstanding: a
   * failed or cancelled row for a file another row has since downloaded, and
   * all but the newest of several failures of one file. They are what the old
   * insert-on-retry left behind. Safe to run on every start.
   */
  collapseSuperseded(): number {
    const identity = "CASE WHEN md5 <> '' THEN 'md5:' || md5 ELSE 'url:' || url END";
    const identified = "(md5 <> '' OR COALESCE(url, '') <> '')";

    const collapse = this.database.transaction(() => {
      const fetched = this.database.run(
        `DELETE FROM items
          WHERE status IN ('failed', 'cancelled') AND ${identified}
            AND ${identity} IN (
              SELECT ${identity} FROM items
               WHERE status IN ('downloaded', 'skipped') AND ${identified})`
      );

      const repeated = this.database.run(
        `DELETE FROM items
          WHERE status = 'failed' AND ${identified}
            AND id NOT IN (
              SELECT MAX(id) FROM items
               WHERE status = 'failed' AND ${identified}
               GROUP BY ${identity})`
      );

      return fetched.changes + repeated.changes;
    });

    return collapse();
  }

  /** Only a waiting item can be dropped; one in flight is left to finish. */
  cancel(id: number): boolean {
    const result = this.database.run(
      `UPDATE items SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ? AND status = 'queued'`,
      [id]
    );

    return result.changes > 0;
  }

  close(): void {
    this.database.close();
  }
}
