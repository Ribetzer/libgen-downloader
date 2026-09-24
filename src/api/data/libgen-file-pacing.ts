import {
  LIBGEN_FILE_LIMIT_WINDOW_MS,
  LIBGEN_FILE_MIN_INTERVAL_MS,
  LIBGEN_PAGE_MIN_INTERVAL_MS,
} from "../../settings";
import { delay } from "../../utilities";

/**
 * Spacing for LibGen file requests (`get.php`), at module scope because the
 * limit belongs to the CDN, per IP: every mirror redirects to the same one, so
 * a private timer per mirror or per queue would be no timer at all.
 *
 * Kept per *lane* - per exit IP. The web server can send downloads out
 * through several VPN connections, and each has an allowance of its own; one
 * lane over the limit must not hold up the others. Everything that does not
 * name a lane shares `DIRECT_LANE`, which is the whole story with one VPN.
 *
 * The CDN answers a request over its limit with an HTTP 500 whose page says
 * so. That is a direct instruction to wait, so it sets a cooldown shared by
 * every later request on that lane, rather than being retried at the ordinary
 * backoff - which only added hits to the count and kept it over the limit.
 */
export const DIRECT_LANE = "direct";

interface LaneState {
  lastRequestAt: number;
  cooldownUntil: number;
}

const lanes = new Map<string, LaneState>();
let minIntervalMs = LIBGEN_FILE_MIN_INTERVAL_MS;

/**
 * Page requests - detail pages, search and JSON lookups - spaced per way out
 * (the proxy, or the process's own connection). The mirrors refuse an
 * address that asks too often with a bare 503, which is a separate limit from
 * the file one and applies to every request, not just downloads.
 */
const pageLastRequestAt = new Map<string, number>();
let pageIntervalMs = LIBGEN_PAGE_MIN_INTERVAL_MS;

export const paceLibgenPage = async (key = DIRECT_LANE): Promise<void> => {
  const now = Date.now();
  const previous = pageLastRequestAt.get(key) ?? 0;
  const waitMs = Math.max(0, previous + pageIntervalMs - now);
  pageLastRequestAt.set(key, Math.max(now, previous + pageIntervalMs));

  if (waitMs > 0) {
    await delay(waitMs);
  }
};

const laneState = (lane: string): LaneState => {
  let state = lanes.get(lane);
  if (!state) {
    state = { lastRequestAt: 0, cooldownUntil: 0 };
    lanes.set(lane, state);
  }

  return state;
};

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

/** Wait for this request's turn on its lane. */
export const paceLibgenFile = async (lane = DIRECT_LANE): Promise<void> => {
  const state = laneState(lane);
  const now = Date.now();
  const waitMs = libgenFileWaitMs(now, state.lastRequestAt, state.cooldownUntil);
  // Claim the slot before waiting, so callers arriving together space out
  // instead of all reading the same stale timestamp and going out at once.
  state.lastRequestAt = Math.max(now, state.lastRequestAt + minIntervalMs, state.cooldownUntil);

  if (waitMs > 0) {
    await delay(waitMs);
  }
};

/** The CDN refused: hold every file request on this lane until its window has passed. */
export const noteLibgenFileLimit = (windowMs: number, lane = DIRECT_LANE): void => {
  const state = laneState(lane);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + windowMs);
};

/** When the lane's current cooldown expires; 0 when there is none. */
export const libgenFileCooldownUntil = (lane = DIRECT_LANE): number =>
  lanes.get(lane)?.cooldownUntil ?? 0;

/**
 * For tests, which must not sit out a real interval: `test/support/setup.ts`
 * runs this before every test with an interval of 0.
 */
export const resetLibgenFilePacing = (intervalMs = LIBGEN_FILE_MIN_INTERVAL_MS): void => {
  lanes.clear();
  pageLastRequestAt.clear();
  minIntervalMs = intervalMs;
  // The same switch for pages: tests pass 0 for both, the default restores both.
  pageIntervalMs = LIBGEN_PAGE_MIN_INTERVAL_MS;
  if (intervalMs === 0) {
    pageIntervalMs = 0;
  }
};
