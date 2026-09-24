import { LIBGEN_FILE_LIMIT_WINDOW_MS, LIBGEN_FILE_MIN_INTERVAL_MS } from "../../settings";
import { delay } from "../../utilities";

/**
 * Spacing for LibGen file requests (`get.php`), at module scope because the
 * limit belongs to the CDN, per IP: every mirror redirects to the same one, so
 * a private timer per mirror or per queue would be no timer at all.
 *
 * The CDN answers a request over its limit with an HTTP 500 whose page says
 * so. That is a direct instruction to wait, so it sets a cooldown shared by
 * every later request, rather than being retried at the ordinary backoff -
 * which only added hits to the count and kept it over the limit indefinitely.
 */
let lastRequestAt = 0;
let cooldownUntil = 0;
let minIntervalMs = LIBGEN_FILE_MIN_INTERVAL_MS;

const LIMIT_PAGE =
  /downloaded too (?:much|many) files(?:\s*\((\d+)\))?\s*in the last\s*(\d+)\s*seconds/i;

/**
 * The window the limit page names, when `body` is that page; `undefined` for
 * any other response. `files` is the limit it quotes, for the message.
 */
export const readFileLimit = (body: string): { windowMs: number; files?: number } | undefined => {
  const match = LIMIT_PAGE.exec(body);
  if (!match) {
    return undefined;
  }

  let windowMs = LIBGEN_FILE_LIMIT_WINDOW_MS;
  if (match[2]) {
    windowMs = Number(match[2]) * 1000;
  }

  let files: number | undefined;
  if (match[1]) {
    files = Number(match[1]);
  }

  return { windowMs, files };
};

/** How long a request arriving now has to wait: the interval or the cooldown. */
export const libgenFileWaitMs = (
  now: number,
  previousRequestAt: number,
  limitedUntil: number,
  intervalMs = minIntervalMs
): number => Math.max(0, previousRequestAt + intervalMs - now, limitedUntil - now);

/** Wait for this request's turn. */
export const paceLibgenFile = async (): Promise<void> => {
  const now = Date.now();
  const waitMs = libgenFileWaitMs(now, lastRequestAt, cooldownUntil);
  // Claim the slot before waiting, so callers arriving together space out
  // instead of all reading the same stale timestamp and going out at once.
  lastRequestAt = Math.max(now, lastRequestAt + minIntervalMs, cooldownUntil);

  if (waitMs > 0) {
    await delay(waitMs);
  }
};

/** The CDN refused: hold every LibGen file request until its window has passed. */
export const noteLibgenFileLimit = (windowMs: number): void => {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + windowMs);
};

/** When the current cooldown expires; 0 when there is none. */
export const libgenFileCooldownUntil = (): number => cooldownUntil;

/**
 * For tests, which must not sit out a real interval: `test/support/setup.ts`
 * runs this before every test with an interval of 0.
 */
export const resetLibgenFilePacing = (intervalMs = LIBGEN_FILE_MIN_INTERVAL_MS): void => {
  lastRequestAt = 0;
  cooldownUntil = 0;
  minIntervalMs = intervalMs;
};
