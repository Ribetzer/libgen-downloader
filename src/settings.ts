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
export const DOWNLOAD_ATTEMPT_COUNT = 3;
export const DOWNLOAD_RETRY_DELAY_MS = 2000;
export const MAX_DOWNLOAD_MIRRORS = 2;

// A mirror that answers 429 or 503 is asking for a slower pace, so those
// retries wait far longer than an ordinary dropped connection.
export const THROTTLE_BACKOFF_MS = [5000, 15_000, 45_000];
export const MAX_RETRY_AFTER_MS = 60_000;

// Windows refuses paths past 260 characters, so the name is budgeted against
// the directory it lands in.
export const MAX_PATH_LENGTH = 250;
export const MIN_FILE_NAME_LENGTH = 40;

export const SEARCH_PAGE_SIZE = 25;

// The editions tab honours `res` and `page`, so a periodical is collected a
// page at a time with a cap that keeps a whole-journal query bounded.
export const ISSUE_PAGE_SIZE = 100;
export const MAX_ISSUE_PAGES = 20;
