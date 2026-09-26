import fs from "node:fs";
import path from "node:path";
import { parseIdentifierList } from "../api/data/file";
import { extractMD5 } from "../api/data/md5";
import { CorpusService } from "./corpus-service";
import { ItemStore, NewQueueItem, QueueItem } from "./database";
import { LaneService, parseProxyList } from "./lane-service";
import { MetadataService } from "./metadata-service";
import { MirrorService } from "./mirror-service";
import { QueueService } from "./queue-service";
import { findFilesForDOI, runSearch } from "./search-service";
import { StorageService } from "./storage-service";
// Straight from package.json: importing ../index would run the CLI entry point.
import packageJson from "../../package.json";
import { QUEUE_CONCURRENCY } from "../settings";
import { DEFAULT_ANNAS_DOMAIN } from "../api/sources/annas-archive";

const PORT = Number(process.env.LIBGEN_PORT || 8095);
const OUTPUT_DIRECTORY = process.env.LIBGEN_OUTPUT_DIR || "/downloads";
const CONFIG_DIRECTORY = process.env.LIBGEN_CONFIG_DIR || "/config";
// Built assets land in build/web, both locally and in the image.
const STATIC_DIRECTORY = process.env.LIBGEN_STATIC_DIR || path.join(process.cwd(), "build", "web");
// Unset means no volume check at all, so an ordinary local or NAS setup is
// untouched; set it to the marker filename a removable disk carries.
const VOLUME_MARKER = process.env.LIBGEN_VOLUME_MARKER || "";
// Told about every finished item, so an indexer downstream does not have to
// poll /api/history. Unset means no notification is sent.
const WEBHOOK_URL = process.env.LIBGEN_WEBHOOK_URL || "";
// A library service that can say which results are already held. Unset simply
// means the UI does not show that, rather than being an error.
const CORPUS_URL = process.env.LIBGEN_CORPUS_URL || "";
// Sent to Crossref as a contact in the User-Agent, which moves the title and
// author lookups for listed DOIs into its faster "polite" pool. Optional.
const CONTACT_EMAIL = process.env.LIBGEN_CONTACT_EMAIL || "";
// An Anna's Archive member key: LibGen's files by MD5 from its fast servers,
// tried when LibGen cannot deliver one. Kept in .env, never in the repository;
// unset turns the fallback off. The domain moves when one is seized.
const ANNAS_KEY = process.env.ANNAS_ARCHIVE_KEY || "";
const ANNAS_DOMAIN = process.env.LIBGEN_ANNAS_DOMAIN || DEFAULT_ANNAS_DOMAIN;
// Other VPN connections to send LibGen downloads through, each an exit IP with
// its own file allowance: `DE-6=http://172.30.0.11:8888,FI-37=…`. The
// process's own connection is always a lane too, named by LIBGEN_LANE_NAME.
const PROXY_LANES = parseProxyList(process.env.LIBGEN_PROXIES || "");
const MAIN_LANE_NAME = process.env.LIBGEN_LANE_NAME || "main";
const LANE_CHECK_MS = 60_000;
// How many items download at once; see QUEUE_CONCURRENCY. With extra lanes,
// two per lane unless set: one connection per exit IP leaves most of each
// allowance unused, and the pacer keeps two well inside it.
let defaultConcurrency = QUEUE_CONCURRENCY;
if (PROXY_LANES.length > 0) {
  defaultConcurrency = (PROXY_LANES.length + 1) * 2;
}
const CONCURRENCY = Number(process.env.LIBGEN_CONCURRENCY) || defaultConcurrency;
const MIRROR_REFRESH_MS = 60 * 60 * 1000;
const MIRROR_RETRY_MS = 30 * 1000;
const HISTORY_LIMIT = 500;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const notFound = () => json({ error: "not found" }, 404);

const noop = () => {};

fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
fs.mkdirSync(CONFIG_DIRECTORY, { recursive: true });

const store = new ItemStore(path.join(CONFIG_DIRECTORY, "libgen-downloader.db"));
const mirrors = new MirrorService();
const storage = new StorageService({ directory: OUTPUT_DIRECTORY, marker: VOLUME_MARKER });
const corpus = new CorpusService({ url: CORPUS_URL });

const notifyFinished = (item: QueueItem) => {
  if (!WEBHOOK_URL) {
    return;
  }

  void fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      md5: item.md5,
      // Which library it came from, and by what identifier. An indexer
      // downstream has to be able to tell an arXiv preprint from a LibGen scan
      // of the published version, and the DOI is what it files either under.
      source: item.source,
      url: item.url,
      doi: item.doi,
      title: item.title,
      status: item.status,
      filename: item.filename,
      path: path.join(OUTPUT_DIRECTORY, item.filename),
      mirror: item.mirror,
      error: item.error,
      total: item.total,
    }),
  }).catch((error: unknown) => {
    console.log(`Webhook for "${item.filename || item.md5}" failed: ${(error as Error).message}`);
  });
};

const lanes = new LaneService([{ key: MAIN_LANE_NAME }, ...PROXY_LANES]);

const queue = new QueueService({
  store,
  lanes: lanes.lanes,
  isLaneReady: lanes.isReady,
  onLaneTrouble: lanes.bench,
  mirrors,
  outputDirectory: OUTPUT_DIRECTORY,
  storage,
  concurrency: CONCURRENCY,
  annasKey: ANNAS_KEY,
  annasDomain: ANNAS_DOMAIN,
  onFinished: notifyFinished,
  // The same lookup `POST /api/queue` does for a `{"doi": …}` body, run by the
  // queue itself for a DOI that arrived in an uploaded list - on the worker's
  // lane, so Sci-Hub's captcha, which is per IP, is spread across every VPN
  // connection instead of all landing on the main one.
  resolveDOI: (doi, lane) => resolveRequestedItem({ doi }, lane?.proxy),
});

const metadata = new MetadataService({
  store,
  contact: CONTACT_EMAIL,
  onUpdated: (items) => queue.refreshed(items),
});

const recovered = store.recoverInterrupted();
if (recovered > 0) {
  console.log(`Requeued ${recovered} item(s) interrupted by a restart`);
}

const collapsed = store.collapseSuperseded();
if (collapsed > 0) {
  console.log(`Removed ${collapsed} failed item(s) superseded by a later download or attempt`);
}

/**
 * In a stack the app usually starts before the VPN tunnel is ready, so a failed
 * refresh is retried in seconds rather than left for an hour. A refresh that
 * succeeds also nudges the queue, which is how the stack recovers by itself
 * after the tunnel drops and comes back.
 *
 * The same timer re-reads the output volume, so a removable disk that gets
 * plugged back in resumes the queue without a restart.
 */
const scheduleMirrorRefresh = (delayMs: number) => {
  setTimeout(() => {
    void (async () => {
      // Re-armed whatever happens: this timer is the only thing that clears
      // "unreachable", so a refresh that throws must not end the chain.
      let nextDelayMs = MIRROR_RETRY_MS;
      try {
        const refreshed = await mirrors.refresh();

        storage.forget();
        const volumeReady = await storage.isReady();

        if (refreshed && volumeReady) {
          nextDelayMs = MIRROR_REFRESH_MS;
        }

        if (refreshed) {
          queue.start();
        }
      } catch (error: unknown) {
        console.error(`Mirror refresh failed: ${(error as Error).message}`);
      } finally {
        scheduleMirrorRefresh(nextDelayMs);
      }
    })();
  }, delayMs).unref?.();
};

const startedWithMirror = await mirrors.refresh();
const startedWithVolume = await storage.getState();

if (VOLUME_MARKER) {
  if (startedWithVolume.ready) {
    console.log(`Output volume confirmed by ${VOLUME_MARKER}`);
  } else {
    console.log(startedWithVolume.reason);
  }
}

let firstDelayMs = MIRROR_RETRY_MS;
if (startedWithMirror && startedWithVolume.ready) {
  firstDelayMs = MIRROR_REFRESH_MS;
}
scheduleMirrorRefresh(firstDelayMs);

// Proxied lanes stay out of rotation until they have answered once.
await lanes.probe();
lanes.watch(LANE_CHECK_MS, () => queue.start());

queue.start();
// Anything a previous run queued but never finished looking up.
metadata.wake();

/**
 * Every queue change is pushed to connected browsers, so progress reads live
 * without polling.
 */
const openEventStream = (): Response => {
  const encoder = new TextEncoder();
  let unsubscribe = noop;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      send({ type: "snapshot", items: store.listActive() });
      unsubscribe = queue.subscribe((event) => {
        try {
          send(event);
        } catch {
          // The browser went away mid-write; cancel() cleans up.
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};

const serveStatic = async (pathname: string): Promise<Response> => {
  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = path.join(STATIC_DIRECTORY, relativePath);

  // Never serve outside the static root, whatever the browser asks for.
  if (!candidate.startsWith(STATIC_DIRECTORY)) {
    return notFound();
  }

  const file = Bun.file(candidate);
  if (await file.exists()) {
    return new Response(file);
  }

  // Anything unmatched falls back to the app shell.
  const indexFile = Bun.file(path.join(STATIC_DIRECTORY, "index.html"));
  if (await indexFile.exists()) {
    return new Response(indexFile, { headers: { "content-type": "text/html" } });
  }

  return notFound();
};

interface QueueRequestItem {
  md5?: string;
  doi?: string;
  title?: string;
  /** A direct URL, for a result that came from a source with no MD5. */
  url?: string;
  source?: string;
}

/**
 * A DOI names a work, not a file, so it has to be looked up before it can be
 * queued. Doing it here saves every caller a search-then-queue round trip, and
 * a DOI is the identifier other tools actually hold.
 *
 * The lookup now covers Sci-Hub as well as LibGen, so a paper LibGen has never
 * held can still be fetched by DOI alone - which is the whole point of the
 * `{"doi": …}` body for the paired RAG corpus.
 */
async function resolveRequestedItem(
  item: QueueRequestItem,
  proxy?: string
): Promise<NewQueueItem | { reason: string; transient?: boolean }> {
  const requestedDOI = (item.doi || "").trim();
  const requestedURL = (item.url || "").trim();

  // A URL is already a location: nothing to look up.
  if (requestedURL) {
    return {
      url: requestedURL,
      title: item.title || "",
      doi: requestedDOI,
      source: item.source || "",
      md5: extractMD5(item.md5 || ""),
    };
  }

  const md5 = extractMD5(item.md5 || "");
  if (md5) {
    return { md5, title: item.title || "", doi: requestedDOI, source: item.source || "libgen" };
  }

  if (!requestedDOI) {
    return { reason: "no usable md5, url or doi" };
  }

  const { items, unanswered } = await findFilesForDOI(mirrors, requestedDOI, proxy);

  // A DOI can name several files - different scans of the same book, say -
  // and several libraries too: LibGen's best match when it has one, and
  // Sci-Hub's copy when it does not.
  const [first] = items;
  if (!first) {
    // "No file anywhere" only when every source actually answered. A source
    // that could not be asked - Sci-Hub wanting a captcha, most often - may
    // well hold it: that is worth asking again later, not giving up on.
    if (unanswered.length > 0) {
      return {
        reason: `nothing found yet for ${requestedDOI} - ${unanswered.join("; ")}`,
        transient: true,
      };
    }

    return { reason: `no file on any source for ${requestedDOI}` };
  }

  // The source's own record often knows the DOI even when the caller queued by
  // MD5, so take it from there rather than lose it.
  return {
    md5: first.md5,
    url: first.downloadURL,
    source: first.source,
    title: item.title || first.articleTitle || first.title || "",
    doi: requestedDOI || first.doi || "",
  };
}

/**
 * Proxied rather than called from the browser so the page stays same-origin -
 * no CORS to arrange on the other service, and its address stays server-side.
 */
const handleOwnedPost = async (request: Request): Promise<Response> => {
  return json(await corpus.owned(await request.text()));
};

/** The `id` from a JSON body, or undefined when there is no usable body. */
const readOptionalId = async (request: Request): Promise<number | undefined> => {
  try {
    const body = (await request.json()) as { id?: unknown };
    if (typeof body?.id === "number" && Number.isInteger(body.id)) {
      return body.id;
    }
  } catch {
    // No body at all is how "retry everything" is expressed.
  }

  return undefined;
};

const handleQueuePost = async (request: Request): Promise<Response> => {
  const body = (await request.json()) as { items?: QueueRequestItem[] };
  const requested = body.items || [];

  const accepted: NewQueueItem[] = [];
  const rejected: { input: string; reason: string }[] = [];

  for (const item of requested) {
    const resolved = await resolveRequestedItem(item);

    if ("reason" in resolved) {
      rejected.push({ input: item.md5 || item.doi || item.url || "", reason: resolved.reason });
      continue;
    }

    accepted.push(resolved);
  }

  const added = queue.addMany(accepted);
  return json({ added, rejected });
};

/**
 * An uploaded list of MD5s, DOIs, or both. A DOI is queued as it is and looked
 * up when its turn comes rather than here, so a list of thousands answers at
 * once instead of holding the request open for every lookup.
 */
const handleListPost = async (request: Request): Promise<Response> => {
  const contents = await request.text();
  const { md5List, doiList, invalidLines } = parseIdentifierList(contents);

  const added = queue.addMany([
    ...md5List.map((md5) => ({ md5, source: "libgen", origin: "list" })),
    ...doiList.map((doi) => ({ doi, origin: "list" })),
  ]);
  metadata.wake();
  return json({ added, md5Count: md5List.length, doiCount: doiList.length, invalidLines });
};

const buildFailureList = (): string => {
  const lines = ["# failed downloads, re-upload this file to retry them"];
  for (const item of store.listFailed()) {
    // This file is an MD5 list, and re-uploading it is how it gets retried. A
    // row without an MD5 cannot be expressed here, so it is written as a
    // comment rather than as a line that would come back in as unreadable; the
    // per-row Retry button is what retries those.
    if (!item.md5) {
      lines.push(`# ${item.source}: ${item.url || item.doi} - ${item.error || "unknown error"}`);
      continue;
    }

    lines.push(`${item.md5}\t${item.error || "unknown error"}`);
  }

  return lines.join("\n");
};

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;

  if (!pathname.startsWith("/api/")) {
    return serveStatic(pathname);
  }

  if (pathname === "/api/health") {
    return json({ status: "ok" });
  }

  if (pathname === "/api/config") {
    // `?recheck` is the banner's "check again": look at the disk now rather
    // than answer from the cache, and set the queue going if it is back.
    if (url.searchParams.has("recheck")) {
      storage.forget();
      if (await storage.isReady()) {
        queue.start();
      }
    }

    const state = mirrors.getState();
    const volume = await storage.getState();
    return json({
      version: packageJson.version,
      outputDirectory: OUTPUT_DIRECTORY,
      storageReady: volume.ready,
      storageError: volume.reason,
      mirror: state.mirror?.src || "",
      mirrors: state.mirrors.map((mirror) => mirror.src),
      preferredMirror: state.preferredMirrorSource || "",
      unreachableMirrors: state.unreachableMirrorSources,
      lastRefreshedAt: state.lastRefreshedAt || "",
      lanes: lanes.getStates(),
      concurrency: CONCURRENCY,
      // For the links on rows that could not be fetched automatically, and to
      // say which extra routes are switched on. Never the key itself.
      annasDomain: ANNAS_DOMAIN,
      annasEnabled: Boolean(ANNAS_KEY),
      // A library's EZproxy prefix, for a link a person clicks - never used
      // to fetch anything automatically: licences forbid systematic
      // downloading through a library proxy, and publishers answer it by
      // blocking the whole institution.
      libraryProxy: process.env.LIBGEN_LIBRARY_PROXY || "",
      openAccessEnabled: Boolean(process.env.LIBGEN_OPEN_ACCESS_EMAIL),
      error: state.lastError || "",
    });
  }

  if (pathname === "/api/mirrors/refresh" && request.method === "POST") {
    const refreshed = await mirrors.refresh();
    return json({ refreshed, mirror: mirrors.getState().mirror?.src || "" });
  }

  if (pathname === "/api/search") {
    const query = url.searchParams.get("q") || "";
    if (query.trim().length < 3) {
      return json({ error: "Query must be at least 3 characters long" }, 400);
    }

    const outcome = await runSearch(mirrors, query, Number(url.searchParams.get("page") || 1));
    if (outcome.status === "error") {
      return json({ error: outcome.message }, 502);
    }

    // `notes` carries the sources that failed while others answered. Dropping
    // it here would leave the browser unable to say why arXiv is missing from
    // a result list that otherwise looks complete.
    return json({ kind: outcome.kind, items: outcome.items, notes: outcome.notes });
  }

  if (pathname === "/api/queue") {
    if (request.method === "POST") {
      return handleQueuePost(request);
    }

    return json({ items: store.listActive(), running: queue.isRunning() });
  }

  if (pathname === "/api/queue/md5-list" && request.method === "POST") {
    return handleListPost(request);
  }

  if (pathname === "/api/corpus/owned" && request.method === "POST") {
    return handleOwnedPost(request);
  }

  const cancelMatch = pathname.match(/^\/api\/queue\/(\d+)$/);
  if (cancelMatch && request.method === "DELETE") {
    return json({ cancelled: queue.cancel(Number(cancelMatch[1])) });
  }

  if (pathname === "/api/history") {
    return json({ items: store.listHistory(HISTORY_LIMIT) });
  }

  if (pathname === "/api/history/failed.txt") {
    return new Response(buildFailureList(), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="libgen_downloader_failed.txt"',
      },
    });
  }

  if (pathname === "/api/history/retry" && request.method === "POST") {
    // An `id` retries exactly that row. Without one this still retries every
    // failure, which is right when they are all genuinely outstanding and
    // wrong when they are not - hence the per-row control.
    const requestedId = await readOptionalId(request);
    if (requestedId !== undefined) {
      const item = store.get(requestedId);
      if (!item || item.status !== "failed") {
        return json({ error: "No failed item with that id" }, 404);
      }

      // The same row goes back in the queue, keeping its source and URL. A new
      // row would leave this one behind, still failed and still retryable.
      return json({ retried: queue.retry(item.id) });
    }

    const retried = store.listFailed().filter((item) => queue.retry(item.id));
    return json({ retried: retried.length });
  }

  if (pathname === "/api/history/dismiss" && request.method === "POST") {
    const requestedId = await readOptionalId(request);
    if (requestedId === undefined) {
      return json({ error: "An id is required" }, 400);
    }

    return json({ dismissed: store.dismiss(requestedId) });
  }

  if (pathname === "/api/events") {
    return openEventStream();
  }

  return notFound();
};

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`libgen-downloader web UI on http://localhost:${server.port}`);
console.log(`downloads -> ${OUTPUT_DIRECTORY} (${CONCURRENCY} at once)`);
console.log(`config    -> ${CONFIG_DIRECTORY}`);
let openAccessRoute = "off (no LIBGEN_OPEN_ACCESS_EMAIL)";
if (process.env.LIBGEN_OPEN_ACCESS_EMAIL) {
  openAccessRoute = "Unpaywall + arXiv";
}
let annasRoute = "off (no ANNAS_ARCHIVE_KEY)";
if (ANNAS_KEY) {
  annasRoute = ANNAS_DOMAIN;
}
console.log(`open access -> ${openAccessRoute}; Anna's Archive fallback -> ${annasRoute}`);
