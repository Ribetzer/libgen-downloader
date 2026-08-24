import fs from "node:fs";
import path from "node:path";
import { parseMD5List } from "../api/data/file";
import { extractMD5 } from "../api/data/md5";
import { CorpusService } from "./corpus-service";
import { ItemStore, QueueItem } from "./database";
import { MirrorService } from "./mirror-service";
import { QueueService } from "./queue-service";
import { runSearch } from "./search-service";
import { StorageService } from "./storage-service";
// Straight from package.json: importing ../index would run the CLI entry point.
import packageJson from "../../package.json";

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

const queue = new QueueService({
  store,
  mirrors,
  outputDirectory: OUTPUT_DIRECTORY,
  storage,
  onFinished: notifyFinished,
});

const recovered = store.recoverInterrupted();
if (recovered > 0) {
  console.log(`Requeued ${recovered} item(s) interrupted by a restart`);
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
      const refreshed = await mirrors.refresh();

      storage.forget();
      const volumeReady = await storage.isReady();

      let nextDelayMs = MIRROR_RETRY_MS;
      if (refreshed && volumeReady) {
        nextDelayMs = MIRROR_REFRESH_MS;
      }

      if (refreshed) {
        queue.start();
      }

      scheduleMirrorRefresh(nextDelayMs);
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

queue.start();

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
}

/**
 * A DOI names a work, not a file, so it has to be looked up before it can be
 * queued. Doing it here saves every caller a search-then-queue round trip, and
 * a DOI is the identifier other tools actually hold.
 */
const resolveRequestedItem = async (
  item: QueueRequestItem
): Promise<{ md5: string; title: string; doi: string } | { reason: string }> => {
  const requestedDOI = (item.doi || "").trim();
  const md5 = extractMD5(item.md5 || "");
  if (md5) {
    return { md5, title: item.title || "", doi: requestedDOI };
  }

  if (!requestedDOI) {
    return { reason: "no usable md5 or doi" };
  }

  const outcome = await runSearch(mirrors, requestedDOI, 1);
  if (outcome.status === "error") {
    return { reason: outcome.message };
  }

  // A DOI can name several files - different scans of the same book, say.
  // The first is what the mirror ranks highest.
  const [first] = outcome.items;
  if (!first) {
    return { reason: `no file on any mirror for ${requestedDOI}` };
  }

  // The mirror's own record often knows the DOI even when the caller queued by
  // MD5, so take it from there rather than lose it.
  return {
    md5: first.md5,
    title: item.title || first.title || "",
    doi: requestedDOI || first.doi || "",
  };
};

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

  const accepted: { md5: string; title: string; doi: string }[] = [];
  const rejected: { input: string; reason: string }[] = [];

  for (const item of requested) {
    const resolved = await resolveRequestedItem(item);

    if ("reason" in resolved) {
      rejected.push({ input: item.md5 || item.doi || "", reason: resolved.reason });
      continue;
    }

    accepted.push(resolved);
  }

  const added = queue.addMany(accepted);
  return json({ added, rejected });
};

const handleMD5ListPost = async (request: Request): Promise<Response> => {
  const contents = await request.text();
  const { md5List, invalidLines } = parseMD5List(contents);

  const added = queue.addMany(md5List.map((md5) => ({ md5 })));
  return json({ added, invalidLines });
};

const buildFailureList = (): string => {
  const lines = ["# failed downloads, re-upload this file to retry them"];
  for (const item of store.listFailed()) {
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

    return json({ kind: outcome.kind, items: outcome.items });
  }

  if (pathname === "/api/queue") {
    if (request.method === "POST") {
      return handleQueuePost(request);
    }

    return json({ items: store.listActive(), running: queue.isRunning() });
  }

  if (pathname === "/api/queue/md5-list" && request.method === "POST") {
    return handleMD5ListPost(request);
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

      const added = queue.addMany([{ md5: item.md5, title: item.title, doi: item.doi }]);
      return json({ added });
    }

    const failed = store.listFailed();
    const added = queue.addMany(
      failed.map((item) => ({ md5: item.md5, title: item.title, doi: item.doi }))
    );
    return json({ added });
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
console.log(`downloads -> ${OUTPUT_DIRECTORY}`);
console.log(`config    -> ${CONFIG_DIRECTORY}`);
