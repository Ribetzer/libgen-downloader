export const SCREEN_BASE_APP_WIDTH = 80;
export const SCREEN_PADDING = 5;
export const SCREEN_WIDTH_PERC = 95;

export const CONFIGURATION_URL =
  "https://raw.githubusercontent.com/obsfx/libgen-downloader/configuration/config.v3.json";

export const FAIL_REQ_ATTEMPT_COUNT = 5;
export const FAIL_REQ_ATTEMPT_DELAY_MS = 2000;

// Probing a mirror for a record is a lookup, not a transfer. Keeping the
// attempt count low bounds the cost of walking every mirror for one MD5.
export const PROBE_REQ_ATTEMPT_COUNT = 2;

// How many times a single file transfer is restarted on the same mirror, and
// how many mirrors are allowed to serve transfer attempts for one MD5.
//
// These were 3 and 2 - six attempts, sized like a lookup, which either works
// or does not. A large transfer over a shaky link is neither: a 140 MB volume
// reached ~60 MB and died with "socket connection was closed unexpectedly",
// and six tries were not enough to get one clean run.
//
// Every attempt restarts from byte zero, because libgen's `get.php` ignores
// `Range` - measured: a ranged request answers 200 with the full
// content-length and no `accept-ranges`. There is no resume to be had, so the
// only lever is more chances at a complete transfer.
//
// The cost is honest: a 140 MB file that never succeeds can now move ~3.4 GB
// before giving up. That is the price of not abandoning a download that got
// 43% of the way there, and DOWNLOAD_TOTAL_BUDGET_MS bounds it in time.
export const DOWNLOAD_ATTEMPT_COUNT = 6;
export const MAX_DOWNLOAD_MIRRORS = 4;

// Spacing between restarts on the same mirror. Flat 2s hammered a mirror that
// was already struggling; this backs off and clamps at the last entry, the
// same shape THROTTLE_BACKOFF_MS uses.
export const DOWNLOAD_BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000];
// The first entry, kept as a named default so callers (and tests) that pass a
// single `retryDelayMs` still work.
export const DOWNLOAD_RETRY_DELAY_MS = DOWNLOAD_BACKOFF_MS[0];

// Attempt counts bound the number of tries, not the time they take: 24
// attempts at a few minutes each is hours on a slow link, with the queue
// blocked behind it. This is the ceiling in wall-clock terms.
export const DOWNLOAD_TOTAL_BUDGET_MS = 45 * 60_000;

// A mirror that answers 429 or 503 is asking for a slower pace, so those
// retries wait far longer than an ordinary dropped connection.
export const THROTTLE_BACKOFF_MS = [5000, 15_000, 45_000];
export const MAX_RETRY_AFTER_MS = 60_000;

// A transfer that stops delivering bytes without closing the socket never
// errors, so `attempt` never sees a failure and the sequential queue blocks
// forever - observed wedged at 2.48 of 3.36 MB for an hour, holding up 14
// other files. Silence for this long is treated as a dead transfer, which
// lets the ordinary retry and mirror fall-through do their job.
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

// Windows refuses paths past 260 characters, so the name is budgeted against
// the directory it lands in.
export const MAX_PATH_LENGTH = 250;
export const MIN_FILE_NAME_LENGTH = 40;

// How long a volume check is trusted before the marker is read again. Short
// enough that reconnecting a disk is noticed on its own, long enough that
// draining a queue does not stat once per item.
export const VOLUME_CHECK_TTL_MS = 5000;

// How soon a queue that stopped for a missing mirror or a missing disk tries
// again. The queue owns this rather than the server's config refresh, which
// backs off to hourly once everything is healthy and would leave work parked
// until the next tick.
export const QUEUE_RETRY_MS = 15_000;

// How long to wait on the library service before showing results unannotated.
// Short on purpose: knowing a paper is already held is useful, waiting for it
// is not.
export const CORPUS_TIMEOUT_MS = 5000;

export const SEARCH_PAGE_SIZE = 25;

// LibGen's `ads.php` - the only page carrying the per-request `key` that
// `get.php` needs - answers a bare request with 200 and a zero-byte body. It
// wants a browser User-Agent *and* a Referer; either alone is refused. An empty
// body parses into an empty document, so every mirror looked like it held no
// record for the MD5, which is how a hotlink check reads as "not found
// anywhere". Unlike ARXIV_USER_AGENT, which names this tool because arXiv's
// terms ask callers to identify themselves, this one has to look like a
// browser to be served at all.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// arXiv, searched alongside LibGen rather than instead of it. Fewer rows than
// LibGen returns on purpose: the two lists are concatenated, and a preprint
// server should add to a catalogue search, not bury it.
export const ARXIV_API_URL = "http://export.arxiv.org/api/query";
export const ARXIV_PAGE_SIZE = 10;
// One request per three seconds and a User-Agent that says who is calling:
// both are in arXiv's API terms of use. This is somebody else's free service
// and the search runs in parallel with LibGen's, so the pacing costs nothing
// worth having.
export const ARXIV_MIN_INTERVAL_MS = 3000;
export const ARXIV_USER_AGENT = "libgen-downloader (+https://github.com/obsfx/libgen-downloader)";

// Sci-Hub page hosts, tried in order. Not in the remote config file because
// that one belongs to the upstream project and describes LibGen's mirrors;
// LIBGEN_SCIHUB_HOSTS overrides this list, so a host going dark is a compose
// edit rather than a release. `sci-hub.se` is the standing example - it no
// longer resolves on any resolver, which is why it is not in this list.
export const SCIHUB_HOSTS = ["sci-hub.st", "sci-hub.ru"];

// Sci-Hub's captcha is rate-triggered, so a batch of DOIs queued back to back
// trips it and then reads back as "no file on any source" - the papers look
// absent when they were never really asked for. Unlike arXiv's interval, which
// is a published term of use, this one is inferred: it only has to be slow
// enough that a queue drain does not look like a scrape.
export const SCIHUB_MIN_INTERVAL_MS = 5000;

// What the challenge page itself suggests ("try again in a minute"). Taking it
// at its word beats guessing, and beats carrying on at the normal interval and
// collecting a wall of false negatives.
export const SCIHUB_CHALLENGE_COOLDOWN_MS = 60_000;

// The editions tab honours `res` and `page`, so a periodical is collected a
// page at a time with a cap that keeps a whole-journal query bounded.
export const ISSUE_PAGE_SIZE = 100;
export const MAX_ISSUE_PAGES = 20;

// Title/author lookups for DOIs that arrive in an uploaded list. Crossref's
// list endpoint takes many `doi:` filters at once, so a whole list is a few
// dozen requests; 50 keeps the URL well inside what the API accepts.
export const METADATA_BATCH_SIZE = 50;

// doi.org answers the DOIs Crossref does not hold (DataCite: Zenodo,
// Eurographics), one request each. Both are someone else's free service and
// this is a background job, so it asks slowly rather than as fast as allowed.
export const METADATA_REQUEST_INTERVAL_MS = 1000;

// After a lookup that failed for network reasons rather than for a missing
// record. The DOIs stay pending and are asked about again after this.
export const METADATA_RETRY_MS = 60_000;

// LibGen's file CDN (every mirror's get.php redirects to the same one) allows
// 15 files per 300 seconds per IP, and says so in an HTTP 500 page: "You have
// downloaded too much files (15) in the last 300 seconds, please wait". A
// sequential queue of small papers finishes one every few seconds, so without
// spacing it trips the limit within minutes - and every retry of a refused
// request counts as another file, which kept the counter pinned and failed
// every download. One request per 21s stays under 15 per 300s with a margin.
export const LIBGEN_FILE_MIN_INTERVAL_MS = 21_000;

// How long to stand back when the limit page does not say. It normally does,
// and its own window is used instead.
export const LIBGEN_FILE_LIMIT_WINDOW_MS = 300_000;

// Items the web queue works on at once. LibGen's CDN serves each connection at
// a few tens of KB/s but counts files, not connections, so several transfers
// multiply throughput while LIBGEN_FILE_MIN_INTERVAL_MS keeps the *starts*
// under its limit. Four is a cautious start; the server reads
// LIBGEN_CONCURRENCY to change it without a rebuild.
export const QUEUE_CONCURRENCY = 4;

// LibGen's mirrors answer an address that asks too often with a bare HTTP 503
// "Service Temporarily Unavailable" - detail pages, JSON lookups and get.php
// alike. With several workers per lane resolving pages across five mirrors,
// that tripped within minutes, so page requests are spaced per lane too.
export const LIBGEN_PAGE_MIN_INTERVAL_MS = 3000;

// How long a lane stands back after a mirror said 503 or 429 on a file
// request, when the answer names no Retry-After of its own.
export const LIBGEN_BUSY_COOLDOWN_MS = 60_000;

// How long an item waits before it is tried again after trouble that says
// nothing about the file itself: LibGen's server overloaded, connections
// dropped until the attempts ran out, Sci-Hub asking for a captcha. Retrying
// straight away cannot outlast an outage measured in hours, so the waits
// lengthen; once they are used up the item fails as it always did.
export const DEFER_SCHEDULE_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
