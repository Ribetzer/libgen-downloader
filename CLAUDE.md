# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
```

CI (`.github/workflows/pull-request.yml`, runs on PRs to `master`) executes typecheck → test → lint → format:check → build, then smoke-tests the bundle with `node build/index.js --help`. Run those five locally before pushing.

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

### Adapter layer (`src/api/adapters/`)

Everything mirror-specific — URL shapes, DOM selectors, connection-error detection, field formatting — sits behind the abstract `Adapter` class. `LibgenPlusAdapter` is currently the only implementation. Nothing outside this directory should know LibGen's HTML or URL structure; the rest of the app goes through `store.mirrorAdapter?.…` (optional, because config may not have loaded yet).

Adding a mirror type: new `Adapter` subclass + a case in `getAdapter()` + extend the `MirrorType` union in `src/api/data/config.ts`.

### Store (`src/tui/store/`)

One bound store composed of six slices (`app`, `config`, `download-queue`, `bulk-download-queue`, `cache`, `events`), all typed as `TCombinedStore`. Slices are *not* independent — they reach across via `get()` (e.g. `events.search` uses the cache slice and the config slice's adapter), and each exports an `initial<X>State` object reused by resetters and by tests.

Two non-obvious behaviors:

- **`setEntries()` rebuilds `listItems`.** The rendered list is built by `constructListItems()` and embeds live callbacks (next page, bulk download, exit). Any state that affects those options — `nextPageStatus`, `currentPage` — requires calling `setEntries(entries)` again to take effect; see `checkNextPage` in `events.ts`.
- **The entry cache is keyed by full search URL**, so it is mirror-specific; `switchMirror()` must call `resetEntryCacheMap()`.

### Rendering and input

`App` renders every layout; `Layout` shows its children only when `activeLayout` matches its `LAYOUT_KEY`. Navigation is `setActiveLayout()`, which also clears the screen unless in CLI mode.

The result list is a rotated ring: `constructListItems()` reorders entries so the focused row lands at `RESULT_LIST_ACTIVE_LIST_INDEX`, and `getRenderedListItems()` wraps with modulo. Keyboard handling is local to components — each uses Ink's `useInput` gated by `{ isActive }`, so only the focused row reacts to `[TAB]`/`[D]`/`Enter` (`result-list-item-entry.tsx`, `use-scrollable-list-controls.tsx`).

### Downloads

Both queues delegate to one routine, `downloadByMD5()` in `src/api/data/download.ts`, which owns resolve → fetch → stream, transfer retries, mirror fall-through, and deletion of truncated files. The queues only map its callbacks onto their own progress shapes:

- **Download queue** (`download-queue.ts`): background, non-blocking, driven by `iterateQueue()` until drained; per-entry progress accumulates in `downloadProgressMap` keyed by entry id.
- **Bulk download queue** (`bulk-download-queue.ts`): sequential, index-based status updates, records a per-item `error`/`mirror`, and writes an md5 list file of successful downloads at the end (that file is the input for `-b/--bulk`). Selected entries are deduped by `objectHash(entry)`, not by id.

MD5s are always derived through `src/api/data/md5.ts` (`extractMD5` for text, `getMD5FromURL` for adapter URLs) — never by hand-slicing a string, which is how CRLF endings used to reach the query.

Two invariants worth preserving:

- **Progress is absolute, not incremental.** `onProgress(filename, receivedBytes, total)` reports the byte count for the *current* attempt and the stores assign it. Reintroducing deltas brings back >100% readings whenever a transfer restarts or moves mirror.
- **Names come from `src/api/data/filename.ts`.** `buildDownloadFileName` repairs the ISO-8859-1/UTF-8 mojibake, rebuilds `Title (Year) [DOI].ext`, sanitizes for Windows, and trims the *title* so the extension always survives. The output directory (config slice, `outputDirectory`) is resolved once at startup and threaded through `downloadByMD5`; nothing should write to `./` directly.

### Failure handling

Every remote call is wrapped in `attempt()` (`src/utilities.ts`): 5 tries with 2s delay by default, returns `undefined` instead of throwing. Callers check for `undefined` and surface a warning. Pass `{ attempts, delayMs }` for cheaper probes — mirror lookups use `PROBE_REQ_ATTEMPT_COUNT`.

Downloads recover by mirror, not just by retry. `resolveDownloadURL()` (`src/api/data/resolve.ts`) walks candidate mirrors until one yields a download link, and distinguishes *not_found* (every mirror answered, no record) from *unreachable* (nothing answered) so the reported reason is honest. Candidate ordering lives in the config slice (`getMirrorCandidates`): last mirror that served a file, then the active mirror, then the rest, minus mirrors marked unreachable this run.

Search failures are handled separately: `adapter.detectConnectionError()` inspects the parsed page, and on a mirror-level error `handleSearchSubmit` drives `switchMirror()`, which test-searches each remaining mirror, swaps in the new adapter, clears the cache, and retries once — with `mirrorCheckStates` feeding the failover UI.

## Conventions

- ESLint enforces `no-ternary` (hence the `if` blocks and inline IIFEs used to compute values) and `react/no-multi-comp` (one component per file). `unicorn/recommended` is on, so use `node:` protocol imports; `process.exit` needs an explicit disable comment.
- Double quotes, semicolons, unix linebreaks, Prettier `printWidth: 100`.
- Files and directories are kebab-case; store slices export `create<X>Slice` + `initial<X>State`.
- Tests use `bun:test` and never touch the network: they `spyOn(globalThis, "fetch")` and reset the bound store with `useBoundStore.setState({ ...initialStates }, true)` in `beforeEach`/`afterEach`. Integration tests drive store actions directly rather than rendering Ink.
