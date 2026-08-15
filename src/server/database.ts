import { Database } from "bun:sqlite";

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

export interface QueueItem {
  id: number;
  md5: string;
  title: string;
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
  status: string;
  filename: string | null;
  mirror: string | null;
  error: string | null;
  progress: number | null;
  total: number | null;
  created_at: string;
  updated_at: string;
}

const toQueueItem = (row: ItemRow): QueueItem => ({
  id: row.id,
  md5: row.md5,
  title: row.title || "",
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
    this.database.run("CREATE INDEX IF NOT EXISTS items_status ON items (status)");
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

  add(md5: string, title: string): QueueItem {
    const row = this.database
      .query<
        ItemRow,
        [string, string]
      >("INSERT INTO items (md5, title, status) VALUES (?, ?, 'queued') RETURNING *")
      .get(md5, title);

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

  update(id: number, changes: Partial<Omit<QueueItem, "id" | "createdAt" | "updatedAt">>): void {
    const assignments: string[] = [];
    const values: (string | number)[] = [];

    const columns: Record<string, string> = {
      md5: "md5",
      title: "title",
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
