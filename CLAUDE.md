# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Long-form background lives in `CLAUDE-DETAILED.md`** — the measurements behind
each rule here, the failures that produced them, and the dead ends. Read it
before overriding anything below that looks arbitrary.

## Commands

Bun is the package manager, test runner, and bundler (`bun.lock` is the only lockfile).

```bash
bun install                      # deps
bun run start                    # run the TUI from source (src/index.ts)
bun run start -- -s "some book"  # run with CLI flags

bun test                                  # all tests
bun test test/adapter.test.ts             # single file
bun test -t "parses result rows"          # single test by name

bun run typecheck        # tsc --noEmit
bun run lint             # eslint (bun run lint:fix to autofix)
bun run format:check     # prettier (bun run format to write)

bun run build            # Node bundle -> build/index.js (adds shebang)
bun run compile          # standalone executables -> standalone-executables/

bun run build:webui      # bundles web/ and src/server/ into build/
bun run start:server     # serves the built UI + JSON API, default http://localhost:8095
```

CI (`.github/workflows/pull-request.yml`, runs on PRs to `main`) executes typecheck → test → lint → format:check → build, then smoke-tests the bundle with `node build/index.js --help`. Run those five locally before pushing. It does not build or exercise the web UI/server (`build:webui`) — those are covered only by `bun test`, since the server code has no separate CI job.

Releases are automated: the **Version Bump** workflow runs `npm version`, commits, tags `vX.Y.Z`, and calls `release.yml`, which cross-compiles executables for six targets and publishes a GitHub release. Never hand-edit the version or push tags manually.

## Architecture

A terminal UI (Ink + React) over LibGen's public web pages: fetch HTML → parse with `linkedom` → render. All app state lives in one Zustand store; React components are mostly a view layer over it.

### Entry points and modes

`src/index.ts` → `src/cli/index.ts` (meow flag parsing) → `src/cli/operate.ts`, which branches on flags. Every mode except `-u/--url` ends up calling `renderTUI()` with the same store:

- no flags → interactive TUI, config fetched by the `App` effect
- `-s/--search` → config fetched first, search value seeded, TUI renders, then `handleSearchSubmit()`
- `-b/--bulk` / `-d/--download` → `startInCLIMode: true` + `BULK_DOWNLOAD_LAYOUT`, exits when the queue drains
- `-u/--url` → pure stdout, no Ink render

`startInCLIMode` suppresses screen clearing on layout changes; `doNotFetchConfigInitially` prevents a second config fetch when `operate()` already did one.

### Runtime configuration and mirrors

No mirror is hardcoded. `fetchConfig()` (`src/api/data/config.ts`) fetches `CONFIGURATION_URL` from `src/settings.ts` — `config.v3.json` on this repo's `configuration` branch — which supplies `mirrors` and `latest_version`. `findMirror()` returns the first reachable mirror; `getAdapter(src, type)` maps `mirror.type` to an adapter instance. Changing available mirrors is a config-branch edit, not a code change.

### Two ways in: HTML search and the JSON API

Plain text queries go through the HTML file search (`index.php` → `#tablelibgen` → `parseEntries`). DOIs and issues cannot be found that way, so they go through the mirror's JSON API instead:

- `parseQuery` (`src/api/data/query.ts`) classifies the input as `doi`, `issue` or `text`; the search box and `handleSearchSubmit` both route on it.
- `json.php?object=e&doi=…` returns the edition _with_ its `files` subarray, so a DOI is one request. `--issue` scrapes only edition ids out of the editions tab (`curtab=e`, which carries no MD5s) and then batches them into `json.php?object=e&ids=…`.
- Responses are keyed by id at both levels and answer `[]` or `{"error": …}` for a miss, which is why `parseEditionsJSON` is deliberately tolerant. Real captured responses live in `test/fixtures/` — regenerate them from a machine that can reach libgen rather than hand-editing.
- `buildEntriesFromEditions` converts records into the same `Entry` shape the HTML search produces, so lookups reuse the result list, detail view and both download queues unchanged.

`db.md` and `json.md` in the repo root are LibGen's own database and API documentation, kept as reference for this layer.

### Sources (`src/api/sources/`)

More than one library is searched. A **source** is a library; an **adapter** is
a mirror _of_ one. `Adapter` abstracts over mirrors of the same catalogue —
same HTML, same MD5s, same detail pages — so arXiv, which has none of those,
implements `Source` instead.

`searchSources()` asks every source whose `handles(query)` is true, in
parallel, and merges the results in source order. A source that fails
contributes a `SourceNote` and nothing else, so arXiv being down still returns
LibGen's results; only when _every_ source asked has failed is the search an
error. `/api/search` returns those notes alongside the items.

- `libgen` — all three query kinds. The only source with MD5s.
- `arxiv` — text only. The API's field prefixes are ti/au/abs/co/jr/cat/rn/id/all,
  so there is no `doi:` to search by; asking anyway returns an empty feed, which
  would read as "arXiv has nothing".
- `scihub` — DOI only. Distinguishes _not found_ (404) from _rate limited_
  (200 with no `citation_pdf_url`, the Altcha page) — reporting a captcha as
  "not found" would send the caller elsewhere for a paper Sci-Hub is holding.

**A result is identified by an MD5 _or_ a URL.** `withIdentity` keeps a row
with either and drops only what has neither; the `withMD5` it replaced
discarded every arXiv and Sci-Hub row on the way to the browser. The queue
carries both (`source`, `url` columns) and branches once in `QueueService`.

Sci-Hub's page hosts were behind DDoS-Guard's **self-signed** certificate (no
CN, no SAN), which the code pins: that one certificate as the only trust
anchor, with the hostname check waived since the certificate can't satisfy
it. It is a real pin, not a bypass; substituting a different certificate is
rejected. By September 2026 both page hosts served ordinary Let's Encrypt
certificates, and the pin then rejected everything. So `fetchSciHub` verifies
normally first and falls back to the pin only for a host whose certificate
fails, remembering that host so `downloadRequestInit(url)` pins its downloads
too. Never `NODE_TLS_REJECT_UNAUTHORIZED`: it is global and would disable
verification for LibGen and arXiv too.

### Adapter layer (`src/api/adapters/`)

Everything mirror-specific — URL shapes, DOM selectors, connection-error detection, field formatting — sits behind the abstract `Adapter` class. `LibgenPlusAdapter` is currently the only implementation. Nothing outside this directory should know LibGen's HTML or URL structure; the rest of the app goes through `store.mirrorAdapter?.…` (optional, because config may not have loaded yet).

Adding a mirror type: new `Adapter` subclass + a case in `getAdapter()` + extend the `MirrorType` union in `src/api/data/config.ts`.

### Store (`src/tui/store/`)

One bound store composed of six slices (`app`, `config`, `download-queue`, `bulk-download-queue`, `cache`, `events`), all typed as `TCombinedStore`. Slices are _not_ independent — they reach across via `get()` (e.g. `events.search` uses the cache slice and the config slice's adapter), and each exports an `initial<X>State` object reused by resetters and by tests.

Two non-obvious behaviors:

- **`setEntries()` rebuilds `listItems`.** The rendered list is built by `constructListItems()` and embeds live callbacks (next page, bulk download, exit). Any state that affects those options — `nextPageStatus`, `currentPage` — requires calling `setEntries(entries)` again to take effect; see `checkNextPage` in `events.ts`.
- **The entry cache is keyed by full search URL**, so it is mirror-specific; `switchMirror()` must call `resetEntryCacheMap()`.

### Rendering and input

`App` renders every layout; `Layout` shows its children only when `activeLayout` matches its `LAYOUT_KEY`. Navigation is `setActiveLayout()`, which also clears the screen unless in CLI mode.

The result list is a rotated ring: `constructListItems()` reorders entries so the focused row lands at `RESULT_LIST_ACTIVE_LIST_INDEX`, and `getRenderedListItems()` wraps with modulo. Keyboard handling is local to components — each uses Ink's `useInput` gated by `{ isActive }`, so only the focused row reacts to `[TAB]`/`[D]`/`Enter` (`result-list-item-entry.tsx`, `use-scrollable-list-controls.tsx`).

### Downloads

Both queues delegate to one routine, `downloadByMD5()` in `src/api/data/download.ts`, which owns resolve → fetch → stream, transfer retries, mirror fall-through, and deletion of truncated files. `downloadFromURL()` beside it is the same thing without the resolve step, for a source that hands over the URL itself; both go through the one private `transferFile`, so there is only ever one retry/backoff/stall/resume implementation. A response with no `content-disposition` (Sci-Hub's storage host sends none) falls back to the URL's last path segment for the extension. The queues only map its callbacks onto their own progress shapes:

- **Download queue** (`download-queue.ts`): background, non-blocking, driven by `iterateQueue()` until drained; per-entry progress accumulates in `downloadProgressMap` keyed by entry id.
- **Bulk download queue** (`bulk-download-queue.ts`): sequential, index-based status updates, records a per-item `error`/`mirror`, and writes an md5 list file of successful downloads at the end (that file is the input for `-b/--bulk`). Selected entries are deduped by `objectHash(entry)`, not by id.

MD5s are always derived through `src/api/data/md5.ts` (`extractMD5` for text, `getMD5FromURL` for adapter URLs) — never by hand-slicing a string, which is how CRLF endings used to reach the query.

Four invariants worth preserving:

- **Bytes land in a `.part` file and are renamed only when complete.** Nothing
  at the final path is ever half a file, so `alreadyDownloaded` can trust a
  name it finds. The part file is deliberately _kept_ across attempts — it is
  what the next one resumes from — and removed only when the whole transfer is
  abandoned. `transferFile` sends `Range: bytes=<size>-` and appends **only**
  on a 206; a 200 means the server ignored the ask and the part is overwritten
  from zero, which is what a browser does too. Truncating a response that
  turns out not to be a resume is what loses bytes.
- **A silent transfer must time out.** `DOWNLOAD_STALL_TIMEOUT_MS` (60s of no
  bytes) destroys the source so `pipeline` rejects. Without it a server that
  stops sending without closing never errors, `attempt` never retries, and the
  sequential queue blocks forever. The source is wrapped with
  `Readable.fromWeb`, not `Readable.from` — `from` only iterates a web stream,
  so destroying it leaks the reader and the socket.
- **Progress is absolute, not incremental.** `onProgress(filename, receivedBytes, total)` reports the byte count for the _current_ attempt and the stores assign it. Reintroducing deltas brings back >100% readings whenever a transfer restarts or moves mirror.
- **Names come from `src/api/data/filename.ts`.** `buildDownloadFileName` repairs the ISO-8859-1/UTF-8 mojibake, rebuilds `Title (Year) [DOI].ext`, sanitizes for Windows, and trims the _title_ so the extension always survives. The output directory (config slice, `outputDirectory`) is resolved once at startup and threaded through `downloadByMD5`; nothing should write to `./` directly.

### Failure handling

Every remote call is wrapped in `attempt()` (`src/utilities.ts`): 5 tries with 2s delay by default, returns `undefined` instead of throwing. Callers check for `undefined` and surface a warning. Pass `{ attempts, delayMs }` for cheaper probes — mirror lookups use `PROBE_REQ_ATTEMPT_COUNT`.

**LibGen's file CDN allows 15 files per 300 seconds per IP**, and every
mirror's `get.php` redirects to that same CDN. Going over returns **HTTP 500**
(not 429) with the page "You have downloaded too much files (15) in the last
300 seconds". Retrying that at the ordinary backoff and falling through to the
other mirrors only added to the count, which kept it over the limit, so every
download in a list failed. Now `transferFile({ libgenFile: true })` spaces
requests through `paceLibgenFile` (`LIBGEN_FILE_MIN_INTERVAL_MS`, 21s, shared at
module scope like Sci-Hub's pacer). It also reads the limit page with
`readFileLimit` and sets a shared cooldown for the window the page names. A VPN
exit is shared with other people, so the limit can be hit even at this pace;
the cooldown handles that case. `test/support/setup.ts` (the preload in
`bunfig.toml`) resets the pacer to an interval of 0 before every test.

The web queue runs **several workers at once** (`QUEUE_CONCURRENCY`, 4 by
default; override with `LIBGEN_CONCURRENCY`). It used to be strictly
sequential. The CDN limits files _started_, which the pacer controls whatever
the concurrency, and it serves each connection at only a few tens of KB/s: in
one measurement, three connections carried about three times the bytes of one.
Also, one 400 MB book held up two thousand papers queued behind it. Workers
take rows with `ItemStore.claimNext`, one `UPDATE … RETURNING` that marks the
row `resolving`, so no two workers get the same row. With no mirror
reachable, only rows that carry their own URL are claimed; the rest wait. A
worker that finds nothing re-checks when it exits, against a count of
`start()` calls, because work queued in between would otherwise wait for the
retry timer. In tests that inspect rows as they were queued, pause the queue
with a missing volume marker (`createPausedQueue`), not with "no mirror",
which still lets URL rows through.

**Lanes: one per VPN connection.** A Proton exit IP is shared with strangers,
so one connection spends much of its time waiting out the per-IP limit even at
our own slow pace. `docker-compose.local.yml` runs extra gluetun containers,
each on a different Proton server with `HTTPPROXY=on`, at fixed addresses on
the `lanes` network. Addresses are fixed because the app shares the main
gluetun's network namespace and resolves names through the tunnel's DNS,
where Docker service names don't exist. `LIBGEN_PROXIES`
(`NAME=http://ip:8888,…`) lists them, and `LIBGEN_LANE_NAME` names the main
connection.

- **Pacing:** each lane (`DownloadLane`) is paced separately by the pacer.
- **One lane per download:** a download's detail page and its file go out on
  the same lane, because the `ads.php` key is issued to the address that
  asked for it. `requestInit.proxy` is Bun's per-request proxy, so the type
  is `BunFetchRequestInit`, not the standard `RequestInit`.
- **Spreading workers:** each worker takes the lane with the fewest workers
  that `LaneService` reports as ready. `LaneService` probes each lane every
  minute through Cloudflare's `/cdn-cgi/trace` and logs its exit IP. A lane
  that doesn't answer gets no work until it does.
- **Proxy failures:** a mirror failing through a proxy isn't marked
  unreachable, since the proxy may be the problem, and marking it would
  remove the mirror from every lane.
- **What goes on the lane:** a download's page and file, the DOI lookup's
  Sci-Hub request (`SourceContext.proxy`; Sci-Hub's pacing and captcha
  cooldown are kept per proxy, because the captcha is per IP), and URL
  downloads. LibGen's own JSON lookups stay on the main connection, spaced by
  `paceLibgenPage`.
- **Busy responses are waits, not attempts:** the mirrors answer an address
  that asks too often with a bare 503 (`LIBGEN_PAGE_MIN_INTERVAL_MS` spaces
  page requests to avoid it). A refused page throws in `getDocument` rather
  than parsing as "no record", and a proxied lane where nothing answers puts
  the item back and is benched for 5 minutes. A 503 or 429 on a file request
  cools the lane down and isn't counted as an attempt.
- **Resume counts as progress:** the CDN answers `Range` with 206 (it didn't
  when the transfer code was written). An attempt that leaves more of the
  file on disk than any before it is neither one of the 6 attempts nor time
  charged to the 45-minute budget. Only attempts that get nowhere are.
- **Sci-Hub's certificate pin is a fallback:** in 2026 its page hosts moved to
  Let's Encrypt, and the pin (the self-signed certificate as the only trust
  anchor) then rejected everything. `fetchSciHub` verifies normally first
  and pins only a host that fails on its certificate.
- **Concurrency:** defaults to two workers per lane.

Transfers get their own, larger budget: `DOWNLOAD_ATTEMPT_COUNT` (6) per mirror across `MAX_DOWNLOAD_MIRRORS` (4), spaced by `DOWNLOAD_BACKOFF_MS` and clamped in wall-clock terms by `DOWNLOAD_TOTAL_BUDGET_MS` (45 min). **An attempt count is not a time limit** — 24 tries at a few minutes each is hours with the sequential queue blocked behind one file, which is what the budget exists to bound. `THROTTLE_BACKOFF_MS` is separate and much longer: a mirror answering 429/503 is asking for a slower pace, not reporting a dropped connection.

Output storage is checked, not assumed. `StorageService` (`src/server/storage-service.ts`) reads a marker file named by `LIBGEN_VOLUME_MARKER` inside the output directory; unset disables the check. It exists because an unplugged removable disk yields a _writable_ empty bind mount rather than an error, so a write test passes and the downloads vanish. `QueueService.drain()` treats a failed check exactly like having no mirror — return, leaving items `queued` — and the mirror-refresh timer re-reads it, so reconnecting the disk resumes the queue without a restart.

Downloads recover by mirror, not just by retry. `resolveDownloadURL()` (`src/api/data/resolve.ts`) walks candidate mirrors until one yields a download link, and distinguishes _not_found_ (every mirror answered, no record) from _unreachable_ (nothing answered) so the reported reason is honest. Candidate ordering lives in the config slice (`getMirrorCandidates`): last mirror that served a file, then the active mirror, then the rest, minus mirrors marked unreachable this run.

Search failures are handled separately: `adapter.detectConnectionError()` inspects the parsed page, and on a mirror-level error `handleSearchSubmit` drives `switchMirror()`, which test-searches each remaining mirror, swaps in the new adapter, clears the cache, and retries once — with `mirrorCheckStates` feeding the failover UI.

### Web UI and HTTP API (`src/server/`, `web/`)

`src/server/index.ts` serves `/api/*` and the built UI; one SQLite table holds
both the queue and the history, separated by status. `TERMINAL_STATUSES` decides
which is which, and `recoverInterrupted()` requeues anything left mid-flight by
a restart.

Failure handling is per row, not per batch, and a file has **one row**.
`POST /api/history/retry` (optional `id`) requeues the failed row _in place_
through `QueueService.retry`. It never inserts a new row, because the old
insert-on-retry left stale failures behind that "Retry all" kept requeueing.
`POST /api/history/dismiss` **deletes** the failed row. It used to mark the row
`cancelled`, which moved it to the top of history. `dismiss` is guarded to
`failed` rows exactly as `cancel` is guarded to `queued` ones. `QueueService.add`
reuses a row with the same identity (MD5, else URL): a waiting row is returned
unchanged, and a failed or cancelled one is requeued. At startup,
`collapseSuperseded()` clears failures that a download or a later failure has
superseded.

`POST /api/queue` accepts `{"doi": …}` and `{"url": …}` as well as
`{"md5": …}`, which is how the paired RAG corpus re-fetches truncated papers
without a human in the loop. The DOI lookup now covers Sci-Hub as well as
LibGen, so a paper LibGen never held is still reachable by DOI alone. Retry
requeues the row itself, so its `source` and `url` stay put.

The upload drop zone (`POST /api/queue/md5-list`, `parseIdentifierList`)
accepts DOIs as well as MD5s, in any form `normalizeDOI` reads: raw
`10.x/y`, `doi:`, `doi.org/…` or `https://doi.org/…`. A DOI is **not** looked up
during the upload. It is queued as a DOI-only row, and `QueueService.lookUpDOI`
resolves it when its turn comes, through the injected `resolveDOI`, which is the
same lookup `{"doi": …}` gets. So a list of thousands answers at once, and a DOI
that no source holds becomes an ordinary failed row that can be retried. Rows
are also matched by DOI (case-insensitive) when they have no MD5 or URL.
`resolveRequestedItem` is a function declaration on purpose: the queue can
start draining before the module body reaches it.

Listed rows carry `origin: "list"`. The UI shows a LIST chip, the DOI as it was
written, and underneath it what the DOI is. `MetadataService` looks that up in
the background, separately from downloading, and stores it as JSON in `meta`.
It uses Crossref's list endpoint first (`filter=doi:a,doi:b`, 50 DOIs per
request), then doi.org content negotiation (CSL JSON) for anything Crossref
lacks. doi.org covers DataCite DOIs such as Zenodo and Eurographics. A doi.org
404 is recorded as `missing`, which is how typos in a list show up. **OpenAlex
is not used**: without an API key it draws on a daily budget shared per IP,
which was already exhausted at the VPN exit. `setMetadata` leaves `updated_at`
alone, so history order doesn't change. Updates reach the browser as
`items-refreshed` batches that are merged in place rather than reloaded. An
optional `LIBGEN_CONTACT_EMAIL` puts a `mailto:` in the User-Agent, which moves
requests into Crossref's faster "polite" pool. `failed.txt`, which
is an MD5 list, writes URL-only rows as comments rather than as lines that
would be rejected on the way back in.

## Conventions

- ESLint enforces `no-ternary` (hence the `if` blocks and inline IIFEs used to compute values) and `react/no-multi-comp` (one component per file). `unicorn/recommended` is on, so use `node:` protocol imports; `process.exit` needs an explicit disable comment.
- Double quotes, semicolons, unix linebreaks, Prettier `printWidth: 100`.
- Files and directories are kebab-case; store slices export `create<X>Slice` + `initial<X>State`.
- Tests use `bun:test` and never touch the network: they `spyOn(globalThis, "fetch")` and reset the bound store with `useBoundStore.setState({ ...initialStates }, true)` in `beforeEach`/`afterEach`. Integration tests drive store actions directly rather than rendering Ink.
- **Do not run `lint --fix` to clear the CRLF errors.** ESLint enforces
  `linebreak-style: LF` and the Windows working tree is CRLF, so a local run
  reports thousands of errors in files nobody touched; CI checks out LF and
  passes. Lint your own files with `--rule '{"linebreak-style":"off"}'`.
- **`bun run format` has the same trap, and it writes.** Prettier's
  `endOfLine: lf` rewrites every CRLF file in the tree, so one run turns ~80
  untouched files into working-tree modifications (git normalises on commit, so
  `git diff` shows nothing for them — which makes the mess easy to "clean up"
  destructively). `format:check` fails locally for the same reason and passes in
  CI. Run prettier on your own files by path instead of the whole project.
