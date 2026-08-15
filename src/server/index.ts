import fs from "node:fs";
import path from "node:path";
import { parseMD5List } from "../api/data/file";
import { extractMD5 } from "../api/data/md5";
import { ItemStore } from "./database";
import { MirrorService } from "./mirror-service";
import { QueueService } from "./queue-service";
import { runSearch } from "./search-service";
// Straight from package.json: importing ../index would run the CLI entry point.
import packageJson from "../../package.json";

const PORT = Number(process.env.LIBGEN_PORT || 8095);
const OUTPUT_DIRECTORY = process.env.LIBGEN_OUTPUT_DIR || "/downloads";
const CONFIG_DIRECTORY = process.env.LIBGEN_CONFIG_DIR || "/config";
// Built assets land in build/web, both locally and in the image.
const STATIC_DIRECTORY = process.env.LIBGEN_STATIC_DIR || path.join(process.cwd(), "build", "web");
const MIRROR_REFRESH_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 500;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const notFound = () => json({ error: "not found" }, 404);

const noop = () => {};

fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
fs.mkdirSync(CONFIG_DIRECTORY, { recursive: true });

const store = new ItemStore(path.join(CONFIG_DIRECTORY, "libgen-downloader.db"));
const mirrors = new MirrorService();
const queue = new QueueService({ store, mirrors, outputDirectory: OUTPUT_DIRECTORY });

const recovered = store.recoverInterrupted();
if (recovered > 0) {
  console.log(`Requeued ${recovered} item(s) interrupted by a restart`);
}

await mirrors.refresh();
setInterval(() => {
  void mirrors.refresh();
}, MIRROR_REFRESH_MS);

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

const handleQueuePost = async (request: Request): Promise<Response> => {
  const body = (await request.json()) as { items?: { md5?: string; title?: string }[] };
  const requested = body.items || [];

  const accepted: { md5: string; title: string }[] = [];
  const rejected: string[] = [];

  for (const item of requested) {
    const md5 = extractMD5(item.md5 || "");
    if (!md5) {
      rejected.push(item.md5 || "");
      continue;
    }

    accepted.push({ md5, title: item.title || "" });
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
    return json({
      version: packageJson.version,
      outputDirectory: OUTPUT_DIRECTORY,
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
    const failed = store.listFailed();
    const added = queue.addMany(failed.map((item) => ({ md5: item.md5, title: item.title })));
    return json({ added });
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
