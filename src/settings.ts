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

// The editions tab honours `res` and `page`, so a periodical is collected a
// page at a time with a cap that keeps a whole-journal query bounded.
export const ISSUE_PAGE_SIZE = 100;
export const MAX_ISSUE_PAGES = 20;
