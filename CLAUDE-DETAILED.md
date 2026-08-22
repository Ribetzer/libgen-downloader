# CLAUDE-DETAILED.md

Long-form background for this fork. `CLAUDE.md` carries the rules you need to
write code here; this file carries the evidence behind them — the measurements,
the failures that produced each rule, and the dead ends worth not repeating.

Read this when a rule in `CLAUDE.md` looks arbitrary, or before "simplifying"
something that has a comment defending it.

---

## Downloads

### A transfer can stop without failing

`attempt()` retries on *error*. A server that stops sending bytes while holding
the socket open never produces one, so `await pipeline(...)` never settles. The
whole sequential queue blocks behind one file, indefinitely, with no error
anywhere.

`DOWNLOAD_STALL_TIMEOUT_MS` (60s) destroys the source on silence, which makes
`pipeline` reject, the existing catch remove the partial file, and the ordinary
retry and mirror fall-through take over.

**`Readable.fromWeb`, not `Readable.from`.** This surfaced only because the test
hung: `from` *iterates* a web stream rather than owning it, so destroying the
Readable left the reader and the socket pending — the watchdog would have
unblocked the queue while leaking the connection. With `fromWeb` the destroy
propagates as a cancel. The test then failed with `Controller is already
closed`, which is the proof it reached the stream.

The test asserts the promise *settles at all*. Against the old code it never
does, and the runner hangs.

### Truncated downloads are indistinguishable from complete ones

16 of 47 Journal of Graphics Tools files in the paired corpus arrived truncated:
valid `%PDF` header, real objects, then nothing — no `startxref`, no `trailer`.
They got identified, named, filed and indexed, so the corpus claimed to hold
Möller–Trumbore while holding 322 KB of a prefix.

Two things follow:

- **A short file is deleted, not kept.** `removePartialFile` on any transfer
  error. These 16 predate that.
- **A page count cannot tell you a file is sound.** PyMuPDF is lenient in both
  directions, and a download has two ways to be broken that it happily reads:

  *Truncated.* A JGT paper arrived 2,238 bytes short — exactly the xref table
  and trailer. PyMuPDF opened it, reported 12 pages and returned 5,011
  characters of real text; Docling refused it as "not valid". Readable and
  broken at once. Re-fetching by DOI produced a byte-identical body plus the
  missing tail, which is what confirmed the cause.

  *Not a PDF at all.* Three files were ACM "Session details" sign-in pages
  saved with a `.pdf` extension. PyMuPDF **renders HTML**, so it laid each one
  out and reported 11 pages. Every page-based check passed on a file that was
  never a PDF. Any mirror error page, sign-in wall or interstitial lands this
  way.

  So use two cheap byte tests, not a parse:

  - **`%PDF` in the first bytes** — catches the HTML case.
  - **`%%EOF` and `startxref` both absent from the last 4 KB** — catches
    truncation. Measured over the 1,278-PDF corpus this matched exactly one
    file, the broken one, with no false positives. Searching for the `trailer`
    keyword instead is too loose and produced four, because linearized PDFs and
    cross-reference streams legitimately put it elsewhere.

### Progress is absolute, never a delta

`onProgress(filename, receivedBytes, total)` reports the byte count for the
*current attempt*, and the stores assign rather than accumulate. Reintroducing
deltas brings back >100% readings whenever a transfer restarts or changes
mirror.

---

## Filenames

`buildDownloadFileName` repairs the ISO-8859-1/UTF-8 mojibake, rebuilds
`Title (Year) [DOI].ext`, sanitizes for Windows, and trims **the title only** —
never the extension, never the metadata suffix. A truncated extension makes the
file unopenable; a truncated title is merely shorter.

LibGen elides long conference names mid-string (`[IEEE 2019 11th International
Conference on … (I...{Authors…`), so the title is genuinely absent from the
bytes and no parsing recovers it. That is why `preferredTitle` exists: a caller
that knows the real title beats anything derivable from the name. Year and DOI
still come from the name, where they are reliable.

---

## The web UI

### Per-row retry, and why "retry all" was not enough

"Retry 3 failed" assumes the failures are equivalent. A real history showed they
are not: two rows were the same 158 MB proceedings volume queued twice, and the
third was a file already re-fetched by hand. Pressing it would have downloaded
one thing twice and another needlessly — so the only safe move was to press
nothing, which leaves the count stuck at 3 forever.

`POST /api/history/retry` takes an optional `id`. With no body it still retries
everything, which is right when the failures genuinely are all outstanding.
`POST /api/history/dismiss` marks a row `cancelled` so it leaves `listFailed`
and the badge **without pretending it succeeded**.

Dismiss is guarded to `failed` rows exactly as `cancel` is guarded to `queued`
ones: neither should reach into work in flight.

### Interrupted work is requeued on boot

`database.ts` resets `resolving`, `downloading` and `retrying` back to `queued`
with `progress = 0` at startup. Without it a restart leaves rows stuck in a
state nothing will ever advance.

---

## Storage

`StorageService` reads a marker file named by `LIBGEN_VOLUME_MARKER` inside the
output directory; unset disables the check.

It exists because an unplugged removable disk yields a **writable empty bind
mount** rather than an error. A write test passes and the downloads vanish.

`QueueService.drain()` treats a failed check exactly like having no mirror —
return, leaving items `queued` — and the mirror-refresh timer re-reads it, so
reconnecting the disk resumes the queue without a restart.

---

## Identifying files

`parseQuery` classifies input as `doi`, `issue` or `text`, and the search box
and `handleSearchSubmit` both route on it. DOIs and issues cannot be found
through the HTML file search at all, which is why the JSON API path exists.

- `json.php?object=e&doi=…` returns the edition *with* its `files` subarray, so
  a DOI is one request.
- `--issue` scrapes only edition ids out of the editions tab (`curtab=e`, which
  carries no MD5s) and batches them into `json.php?object=e&ids=…`.
- Responses are keyed by id at both levels and answer `[]` or `{"error": …}` for
  a miss, which is why `parseEditionsJSON` is deliberately tolerant.

Real captured responses live in `test/fixtures/`. Regenerate them from a machine
that can reach libgen rather than hand-editing.

---

## Running behind gluetun

The host cannot reach LibGen directly — a bare `--doi` run answers *"Couldn't
reach any LibGen mirror"*. The container stack routes through gluetun, and
`/downloads` is bound to the host's inbox directory.

The HTTP API is the automation surface:

```
GET  /api/health
GET  /api/config          mirror, output directory, storage readiness
GET  /api/search?q=       q may be a DOI
POST /api/queue           {"items":[{"doi":"10.1080/…"}]}  — resolves DOI to MD5
GET  /api/queue           active items
GET  /api/history         terminal items
POST /api/history/retry   optional {"id": N}
POST /api/history/dismiss {"id": N}
```

`POST /api/queue` accepts DOIs directly, which is how 14 truncated JGT papers
were re-fetched in one call.

---

## Dead ends

**Do not `--fix` the lint.** ESLint enforces `linebreak-style: LF` and the
working tree is CRLF on Windows, so a local run reports thousands of errors in
files nobody touched. CI checks out LF and passes. Lint your own files with
`--rule '{"linebreak-style":"off"}'` instead of rewriting the tree.
