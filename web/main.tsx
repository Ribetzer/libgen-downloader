import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface ServerConfig {
  version: string;
  outputDirectory: string;
  storageReady: boolean;
  storageError: string;
  mirror: string;
  mirrors: string[];
  preferredMirror: string;
  unreachableMirrors: string[];
  lastRefreshedAt: string;
  error: string;
}

interface QueueItem {
  id: number;
  md5: string;
  source: string;
  url: string;
  doi: string;
  title: string;
  status: string;
  filename: string;
  mirror: string;
  error: string;
  progress: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

interface SearchItem {
  /** Which library it came from. */
  source: string;
  /** LibGen's identifier; empty for a source that has none. */
  md5: string;
  /** A direct URL, for a source that hands one over instead of an MD5. */
  downloadURL: string;
  title: string;
  articleTitle: string;
  doi: string;
  authors: string;
  publisher: string;
  year: string;
  pages: string;
  size: string;
  extension: string;
}

/** Why one library came back empty while the others did not. */
interface SourceNote {
  source: string;
  message: string;
}

const SOURCE_LABELS: Record<string, string> = {
  libgen: "LibGen",
  arxiv: "arXiv",
  scihub: "Sci-Hub",
};

const sourceLabel = (source: string): string => SOURCE_LABELS[source] || source;

/**
 * What identifies a row in the list. An MD5 no longer does it on its own:
 * arXiv and Sci-Hub results have none, so keying on `md5` alone would give
 * every one of them the same empty key.
 */
const resultKey = (item: SearchItem): string => `${item.source}:${item.md5 || item.downloadURL}`;

/** Everything needed to queue a row, whichever source it came from. */
const queueRequest = (item: SearchItem) => ({
  md5: item.md5,
  url: item.downloadURL,
  source: item.source,
  // The work's own title, not LibGen's journal-and-issue line: this is what
  // ends up in the filename.
  title: item.articleTitle || item.title,
  doi: item.doi,
});

const ACTIVE_STATUSES = new Set(["queued", "resolving", "downloading", "retrying"]);

const formatBytes = (bytes: number): string => {
  if (!bytes) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
};

const statusLabel = (status: string): string => {
  if (status === "skipped") {
    return "already have";
  }

  return status;
};

const Chip = ({ status }: { status: string }) => (
  <span className={`chip ${status}`}>{statusLabel(status)}</span>
);

const SourceChip = ({ source }: { source: string }) => (
  <span className={`chip-source ${source}`}>{sourceLabel(source)}</span>
);

const ItemRows = ({
  items,
  onCancel,
  onRetry,
  onDismiss,
}: {
  items: QueueItem[];
  onCancel?: (id: number) => void;
  onRetry?: (id: number) => void;
  onDismiss?: (id: number) => void;
}) => (
  <>
    {items.map((item) => {
      let percentage = 0;
      if (item.total > 0) {
        percentage = Math.min((item.progress / item.total) * 100, 100);
      }

      return (
        <tr key={item.id}>
          <td className="nowrap">
            <Chip status={item.status} />
          </td>
          <td className="title">
            <div>
              {item.source !== "libgen" && <SourceChip source={item.source} />}
              {item.filename || item.title || (
                <span className="md5">{item.md5 || item.url || item.doi}</span>
              )}
            </div>
            {item.status === "downloading" && (
              <div className="progress">
                <div style={{ width: `${percentage}%` }} />
              </div>
            )}
            {item.error && <div className="error">{item.error}</div>}
          </td>
          <td className="nowrap">
            {formatBytes(item.progress)}
            {item.total > 0 && ` / ${formatBytes(item.total)}`}
          </td>
          <td className="nowrap">
            <div className="row-actions">
              {onCancel && item.status === "queued" && (
                <button className="small" onClick={() => onCancel(item.id)}>
                  Cancel
                </button>
              )}
              {onRetry && item.status === "failed" && (
                <button className="small" onClick={() => onRetry(item.id)}>
                  Retry
                </button>
              )}
              {onDismiss && item.status === "failed" && (
                <button
                  className="small dismiss"
                  title="Remove from the failed list without retrying"
                  onClick={() => onDismiss(item.id)}
                >
                  &#215;
                </button>
              )}
            </div>
          </td>
        </tr>
      );
    })}
  </>
);

const App = () => {
  const [config, setConfig] = useState<ServerConfig | undefined>();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searchNotes, setSearchNotes] = useState<SourceNote[]>([]);
  // Empty means every source. Isolating one is the honest way to compare
  // libraries: their relevance scores are not on the same scale.
  const [sourceFilter, setSourceFilter] = useState("");
  // Indices of results the library already holds.
  const [owned, setOwned] = useState<Set<number>>(new Set());
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [uploadNote, setUploadNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadConfig = useCallback(async () => {
    const response = await fetch("/api/config");
    setConfig((await response.json()) as ServerConfig);
  }, []);

  const loadHistory = useCallback(async () => {
    const response = await fetch("/api/history");
    const payload = (await response.json()) as { items: QueueItem[] };
    setHistory(payload.items);
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadHistory();
  }, [loadConfig, loadHistory]);

  // One stream carries the snapshot and every later change, so the queue reads
  // live without polling.
  useEffect(() => {
    const source = new EventSource("/api/events");

    source.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as
        | { type: "snapshot"; items: QueueItem[] }
        | { type: "item-added" | "item-updated"; item: QueueItem }
        | { type: "queue-idle" };

      if (payload.type === "snapshot") {
        setQueueItems(payload.items);
        return;
      }

      if (payload.type === "queue-idle") {
        void loadHistory();
        return;
      }

      setQueueItems((previous) => {
        const next = previous.filter((item) => item.id !== payload.item.id);
        if (ACTIVE_STATUSES.has(payload.item.status)) {
          next.push(payload.item);
          next.sort((left, right) => left.id - right.id);
          return next;
        }

        void loadHistory();
        return next;
      });
    });

    return () => source.close();
  }, [loadHistory]);

  /**
   * Flags results the library already holds. Deliberately after the results are
   * rendered rather than before: knowing you already own something is useful,
   * but waiting on a second service before showing any results is not.
   */
  const markOwned = useCallback(async (items: SearchItem[]) => {
    try {
      const response = await fetch("/api/corpus/owned", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // articleTitle, not title: LibGen's file search puts the journal and
          // issue in `title` and the real one after a slash, so matching on
          // `title` would compare "ACM Transactions on Graphics 2002-jul…"
          // against a catalogue of article titles and never hit.
          items: items.map((item) => ({ title: item.articleTitle, doi: item.doi })),
        }),
      });
      const payload = (await response.json()) as { owned?: number[] };
      setOwned(new Set(payload.owned || []));
    } catch {
      // No library configured, or it is down. The results stand on their own.
    }
  }, []);

  const search = useCallback(async () => {
    if (query.trim().length < 3) {
      setSearchError("Type at least 3 characters, a DOI, or issuesid:… issuevolume:…");
      return;
    }

    setSearching(true);
    setSearchError("");
    setSearchNotes([]);
    setSourceFilter("");
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const payload = (await response.json()) as {
        items?: SearchItem[];
        notes?: SourceNote[];
        error?: string;
      };

      if (payload.error) {
        setSearchError(payload.error);
        setResults([]);
        return;
      }

      const items = payload.items || [];
      setResults(items);
      // A library that failed while the others answered. Shown alongside the
      // results rather than instead of them.
      setSearchNotes(payload.notes || []);
      setOwned(new Set());
      if (items.length === 0) {
        setSearchError("Nothing found on any source");
      } else {
        void markOwned(items);
      }
    } catch (error) {
      setSearchError(String(error));
    } finally {
      setSearching(false);
    }
  }, [query, markOwned]);

  const enqueue = useCallback(async (items: SearchItem[]) => {
    await fetch("/api/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: items.map((item) => queueRequest(item)) }),
    });
  }, []);

  const uploadList = useCallback(async (file: File) => {
    const response = await fetch("/api/queue/md5-list", {
      method: "POST",
      body: await file.text(),
    });
    const payload = (await response.json()) as {
      added: QueueItem[];
      invalidLines: { lineNumber: number; content: string }[];
    };

    let note = `Queued ${payload.added.length} MD5${payload.added.length === 1 ? "" : "s"}`;
    if (payload.invalidLines.length > 0) {
      note += `, skipped ${payload.invalidLines.length} unreadable line(s)`;
    }
    setUploadNote(note);
  }, []);

  const cancel = useCallback(async (id: number) => {
    await fetch(`/api/queue/${id}`, { method: "DELETE" });
  }, []);

  const retryFailed = useCallback(async () => {
    await fetch("/api/history/retry", { method: "POST" });
    void loadHistory();
  }, [loadHistory]);

  const retryOne = useCallback(
    async (id: number) => {
      await fetch("/api/history/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      void loadHistory();
    },
    [loadHistory]
  );

  const dismissOne = useCallback(
    async (id: number) => {
      await fetch("/api/history/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      void loadHistory();
    },
    [loadHistory]
  );

  const failedCount = useMemo(
    () => history.filter((item) => item.status === "failed").length,
    [history]
  );

  /** Which libraries actually returned something, in the order they were listed. */
  const availableSources = useMemo(() => {
    const seen: string[] = [];
    for (const item of results) {
      if (!seen.includes(item.source)) {
        seen.push(item.source);
      }
    }

    return seen;
  }, [results]);

  /**
   * The rows to show, each with its position in the unfiltered list. `owned` is
   * keyed by that position - the library service is asked about every result at
   * once - so filtering must not renumber them.
   */
  const visibleResults = useMemo(
    () =>
      results
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !sourceFilter || item.source === sourceFilter),
    [results, sourceFilter]
  );

  return (
    <>
      <header>
        <h1>libgen-downloader</h1>
        <span className="meta">
          <span className={`status-dot ${config?.mirror ? "ok" : "bad"}`} />
          mirror <strong>{config?.mirror || "none"}</strong>
        </span>
        <span className="meta">
          <span className={`status-dot ${config && !config.storageReady ? "bad" : "ok"}`} />
          downloads to <strong>{config?.outputDirectory || "…"}</strong>
        </span>
        <span className="meta">v{config?.version || "…"}</span>
      </header>

      {config?.storageError && (
        <div className="banner">
          {config.storageError} —{" "}
          <button className="small" onClick={() => void loadConfig()}>
            check again
          </button>
        </div>
      )}

      {config?.error && (
        <div className="banner">
          {config.error} —{" "}
          <button
            className="small"
            onClick={async () => {
              await fetch("/api/mirrors/refresh", { method: "POST" });
              void loadConfig();
            }}
          >
            retry now
          </button>
        </div>
      )}

      <main>
        <section>
          <h2>Search</h2>
          <div className="body">
            <div className="search-row">
              <input
                type="text"
                value={query}
                placeholder="Title, author, a DOI, or issuesid:13647 issuevolume:17"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void search();
                  }
                }}
              />
              <button className="primary" onClick={() => void search()} disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            <div className="hint">
              LibGen and arXiv are searched together; a DOI also goes to Sci-Hub. An issue
              expression is LibGen&apos;s own and goes only there.
            </div>
            {searchError && <div className="error">{searchError}</div>}
            {searchNotes.map((note) => (
              <div className="hint note" key={note.source}>
                {sourceLabel(note.source)}: {note.message}
              </div>
            ))}
            {availableSources.length > 1 && (
              <div className="filters">
                <button
                  className={`small ${sourceFilter ? "" : "on"}`}
                  onClick={() => setSourceFilter("")}
                >
                  All {results.length}
                </button>
                {availableSources.map((source) => (
                  <button
                    key={source}
                    className={`small ${sourceFilter === source ? "on" : ""}`}
                    onClick={() => setSourceFilter(source)}
                  >
                    {sourceLabel(source)} {results.filter((item) => item.source === source).length}
                  </button>
                ))}
              </div>
            )}
          </div>

          {results.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="title">Title</th>
                  <th className="nowrap">Source</th>
                  <th className="nowrap">Year</th>
                  <th className="nowrap">Type</th>
                  <th className="nowrap">Size</th>
                  <th className="nowrap">
                    <div className="row-actions">
                      <button
                        className="small"
                        onClick={() => void enqueue(visibleResults.map(({ item }) => item))}
                      >
                        Queue {sourceFilter ? sourceLabel(sourceFilter) : "all"}
                      </button>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.map(({ item, index }) => (
                  <tr key={resultKey(item)} className={owned.has(index) ? "owned" : undefined}>
                    <td className="title">
                      <div>
                        {item.articleTitle || item.title}
                        {owned.has(index) && <span className="chip-owned">in corpus</span>}
                      </div>
                      <div className="md5">
                        {item.authors}
                        {item.doi && ` · ${item.doi}`}
                      </div>
                    </td>
                    <td className="nowrap">
                      <SourceChip source={item.source} />
                    </td>
                    <td className="nowrap">{item.year}</td>
                    <td className="nowrap">{item.extension}</td>
                    <td className="nowrap">{item.size}</td>
                    <td className="nowrap">
                      <div className="row-actions">
                        <button className="small" onClick={() => void enqueue([item])}>
                          {owned.has(index) ? "Queue anyway" : "Queue"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2>
            Queue
            <span className="meta">{queueItems.length} active</span>
          </h2>
          {queueItems.length === 0 && <div className="empty">Nothing queued</div>}
          {queueItems.length > 0 && (
            <table>
              <tbody>
                <ItemRows items={queueItems} onCancel={(id) => void cancel(id)} />
              </tbody>
            </table>
          )}
          <div className="body">
            <div
              className={`dropzone ${dragging ? "over" : ""}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) {
                  void uploadList(file);
                }
              }}
            >
              Drop an MD5 list here, or click to choose one
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,text/plain"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void uploadList(file);
                }
              }}
            />
            {uploadNote && <div className="hint">{uploadNote}</div>}
          </div>
        </section>

        <section>
          <h2>
            History
            <span>
              {failedCount > 0 && (
                <button className="small" onClick={() => void retryFailed()}>
                  Retry {failedCount} failed
                </button>
              )}{" "}
              <a className="small" href="/api/history/failed.txt">
                failed.txt
              </a>
            </span>
          </h2>
          {history.length === 0 && <div className="empty">Nothing downloaded yet</div>}
          {history.length > 0 && (
            <table>
              <tbody>
                <ItemRows
                  items={history}
                  onRetry={(id) => void retryOne(id)}
                  onDismiss={(id) => void dismissOne(id)}
                />
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
};

const rootElement = document.querySelector("#root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
