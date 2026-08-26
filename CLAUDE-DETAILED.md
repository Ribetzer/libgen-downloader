# CLAUDE-DETAILED.md

Long-form background for this fork. `CLAUDE.md` carries the rules you need to
write code here; this file carries the evidence behind them — the measurements,
the failures that produced each rule, and the dead ends worth not repeating.

Read this when a rule in `CLAUDE.md` looks arbitrary, or before "simplifying"
something that has a comment defending it.

---

## Downloads

### A transfer can stop without failing

`attempt()` retries on _error_. A server that stops sending bytes while holding
the socket open never produces one, so `await pipeline(...)` never settles. The
whole sequential queue blocks behind one file, indefinitely, with no error
anywhere.

`DOWNLOAD_STALL_TIMEOUT_MS` (60s) destroys the source on silence, which makes
`pipeline` reject, the existing catch remove the partial file, and the ordinary
retry and mirror fall-through take over.

**`Readable.fromWeb`, not `Readable.from`.** This surfaced only because the test
hung: `from` _iterates_ a web stream rather than owning it, so destroying the
Readable left the reader and the socket pending — the watchdog would have
unblocked the queue while leaking the connection. With `fromWeb` the destroy
propagates as a cancel. The test then failed with `Controller is already
closed`, which is the proof it reached the stream.

The test asserts the promise _settles at all_. Against the old code it never
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

  _Truncated._ A JGT paper arrived 2,238 bytes short — exactly the xref table
  and trailer. PyMuPDF opened it, reported 12 pages and returned 5,011
  characters of real text; Docling refused it as "not valid". Readable and
  broken at once. Re-fetching by DOI produced a byte-identical body plus the
  missing tail, which is what confirmed the cause.

  _Not a PDF at all._ Three files were ACM "Session details" sign-in pages
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

### Six attempts, because three were not enough

A 158 MB proceedings volume failed the whole way through three tries — each one
reaching roughly 60 MB before `socket connection was closed unexpectedly`. The
transfer was not broken in any diagnosable way; the link simply would not hold
open long enough, and three chances never caught a clean run.

`DOWNLOAD_ATTEMPT_COUNT` is 6, spaced by a backoff array rather than a flat 2s
— hammering a mirror that is already struggling is how you get throttled by one
that was merely slow. The honest cost: a 140 MB file that never succeeds can
move ~3.4 GB before giving up, which is why `DOWNLOAD_TOTAL_BUDGET_MS` (45 min)
exists. **An attempt count bounds tries, not time**, and the sequential queue
is blocked behind whatever is in flight.

### Ask to resume; believe only a 206

The obvious saving is to not re-send the 60 MB that already arrived, so
`transferFile` stages into `<name>.part`, sends `Range: bytes=<size>-`, and
renames only on completion. Two things make that safe:

- **Append only on 206.** A 200 means the server ignored the header and is
  sending the whole body again, so the part file is overwritten from zero.
  Appending a full body onto a prefix produces a corrupt file that is _longer_
  than the real one, which no size check catches.
- **`content-range`, not `content-length`, gives the total.** A resumed
  response describes only the slice it is sending; reading `content-length`
  there reports a 140 MB file as 80 MB and every progress figure derived from
  it is wrong.

**Measured on libgen's `get.php`: there is no resume to be had.** A ranged
request comes back `200` with the full `content-length` and no `accept-ranges`.
The code still asks, because the request costs one header and Sci-Hub's storage
host and any future mirror may answer differently — but the reason six attempts
is the lever, rather than resumption, is that on the mirror that matters every
attempt genuinely restarts from byte zero.

The part file is **kept** between attempts and removed only when the transfer
is abandoned for good. Nothing at the final path is ever half a file, so
`alreadyDownloaded` can trust a name it finds.

### Progress is absolute, never a delta

`onProgress(filename, receivedBytes, total)` reports the byte count for the
_current attempt_, and the stores assign rather than accumulate. Reintroducing
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

## More than one library

### A source is not a mirror

`Adapter` abstracts over _mirrors of the same catalogue_ — same HTML, same
MD5s, same detail pages — which is why swapping mirrors mid-search works and
why the entry cache is keyed by full search URL. arXiv has none of those
things. Forcing it into `Adapter` would have meant an adapter whose
`getDownloadPageURL` cannot be written, so it implements `Source` instead: one
method, `search(query)`, plus `handles(query)`.

`searchSources()` fans out to every source whose `handles` is true and merges
in source order. **A source that fails contributes a `SourceNote` and nothing
else** — arXiv being down still returns LibGen's results, and only a search
where _every_ source asked has failed is an error. The alternative, failing the
whole search on one bad source, makes adding a source a liability.

### `withMD5` discarded every result that was not LibGen's

The filter guarding the queue asked for an MD5, because for two years every
result had one. arXiv and Sci-Hub rows have no MD5 and never will — they are
identified by URL — so the fan-out worked, the merge worked, and the browser
received LibGen's rows only. Silently: a filter drops things without comment.

`withIdentity` keeps a row with an MD5 **or** a URL and drops only what has
neither. The queue carries both (`source`, `url` columns, added by ALTER TABLE)
and `QueueService` branches once: MD5 → `downloadByMD5`, URL → `downloadFromURL`.
Retry has to carry `source` and `url` through as well, or a retried arXiv row
comes back as an MD5-less LibGen item and fails immediately.

`failed.txt` is an MD5 list, so URL-only rows are written as `#` comments
rather than as lines that would be rejected on the way back in.

### arXiv has no `doi:` field, and asking anyway reads as "nothing found"

The API's field prefixes are `ti/au/abs/co/jr/cat/rn/id/all`. There is no DOI
field. A `doi:10.…` query is _accepted_ and returns an empty feed, which is
indistinguishable from "arXiv does not have this paper" — so `handles()`
returns false for a DOI and arXiv is not asked at all. The DOI that arXiv does
carry (`arxiv:doi`, set once a preprint is published somewhere) is read from
each entry, but it is an output, never an input.

`linkedom`'s `querySelector` cannot express a namespaced tag, so
`querySelector("arxiv:doi")` finds nothing. The children are scanned by name
instead — there are only a handful per entry.

### Sci-Hub: three outcomes, not two

A 200 with no `citation_pdf_url` is not "not found". It is DDoS-Guard's Altcha
challenge page, served when the request rate is too high, and reporting it as
_not found_ sends the caller off to look elsewhere for a paper Sci-Hub is
holding. The classification is:

    404                       -> not_found
    200, no citation_pdf_url  -> challenged  (rate limited; try again later)
    200, citation_pdf_url     -> found

All three have captured fixtures in `test/fixtures/`.

### The certificate is pinned, and the test that proved it was contaminated

Sci-Hub's page hosts sit behind DDoS-Guard's **self-signed** certificate —
`C=EU, ST=*, O=ddos-guard`, no CN, no SAN. The request supplies that one
certificate as its only trust anchor _and_ waives the hostname check the
certificate cannot satisfy. The measurement table lives in
`src/api/sources/scihub.ts`; the line that matters is that a **wrong** CA is
rejected, which is what makes this a pin rather than a bypass.

**The dead end worth recording:** the first run of that table reported `ca only`
as working. It does not. Undici pools connections, so the four cases ran in one
process over a socket the first successful case had already established — the
TLS handshake never happened again and the later results described the earlier
handshake. Each case has to run in its own process. Any future TLS measurement
here has the same trap.

Never reach for `NODE_TLS_REJECT_UNAUTHORIZED`: it is global, and it would
switch verification off for LibGen and arXiv too. `downloadRequestInit(url)`
applies the pin **by host**, so the `/storage/…` spelling served from the page
host is covered while `sci-hub.red` (ordinary Let's Encrypt) is left alone.

`LIBGEN_SCIHUB_HOSTS` overrides the host list, so a host going dark is a
compose-file edit rather than a release.

## Identifying files

`parseQuery` classifies input as `doi`, `issue` or `text`, and the search box
and `handleSearchSubmit` both route on it. DOIs and issues cannot be found
through the HTML file search at all, which is why the JSON API path exists.

- `json.php?object=e&doi=…` returns the edition _with_ its `files` subarray, so
  a DOI is one request.
- `--issue` scrapes only edition ids out of the editions tab (`curtab=e`, which
  carries no MD5s) and batches them into `json.php?object=e&ids=…`.
- Responses are keyed by id at both levels and answer `[]` or `{"error": …}` for
  a miss, which is why `parseEditionsJSON` is deliberately tolerant.

Real captured responses live in `test/fixtures/`. Regenerate them from a machine
that can reach libgen rather than hand-editing.

---

## Running behind gluetun

The host cannot reach LibGen directly — a bare `--doi` run answers _"Couldn't
reach any LibGen mirror"_. The container stack routes through gluetun, and
`/downloads` is bound to the host's inbox directory.

The HTTP API is the automation surface:

    GET  /api/health
    GET  /api/config          mirror, output directory, storage readiness
    GET  /api/search?q=       q may be a DOI; answers items + source notes
    POST /api/queue           {"items":[{"doi":"10.1080/…"}]}  — resolves DOI
    GET  /api/queue           active items
    GET  /api/history         terminal items
    POST /api/history/retry   optional {"id": N}
    POST /api/history/dismiss {"id": N}

`POST /api/queue` accepts `{"md5": …}`, `{"doi": …}` and `{"url": …}`, which is
how 14 truncated JGT papers were re-fetched in one call with no human in the
loop. The DOI route now covers Sci-Hub as well as LibGen, so a paper LibGen
never held is still reachable by DOI alone.

`/api/search` returns `notes` alongside `items` — one per source that failed or
was rate limited. Without them a partial result looks like a complete one.

---

## Dead ends

**Do not `--fix` the lint.** ESLint enforces `linebreak-style: LF` and the
working tree is CRLF on Windows, so a local run reports thousands of errors in
files nobody touched. CI checks out LF and passes. Lint your own files with
`--rule '{"linebreak-style":"off"}'` instead of rewriting the tree.
