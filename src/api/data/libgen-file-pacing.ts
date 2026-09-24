import {
  LIBGEN_FILE_LIMIT_WINDOW_MS,
  LIBGEN_FILE_MAX_INTERVAL_MS,
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
  /**
   * This lane's spacing between file requests. It starts at the minimum,
   * grows by half each time the lane is refused under the limit, and eases
   * back a second per clean start: the same spacing that suits one exit IP
   * keeps another - busier with strangers - over the limit, and every
   * refusal costs the lane a five-minute blackout.
   */
  intervalMs: number;
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
    state = { lastRequestAt: 0, cooldownUntil: 0, intervalMs: minIntervalMs };
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

/**
 * LibGen's database running out of connections, as its download server
 * reports it: an HTTP 500 carrying the MySQL error - captured through a lane,
 * "3306. User 'libgen_get' has exceeded the 'max_user_connections' resource".
 * It is the whole server being overloaded, for everyone, and says nothing
 * about the file; read by status alone it counted as a failed attempt.
 */
const BUSY_PAGE = /max_user_connections|too many connections|SQLSTATE\[HY000\] \[1040\]/i;

export const readBusyPage = (body: string): boolean => BUSY_PAGE.test(body);

/** How long a request arriving now has to wait: the interval or the cooldown. */
export const libgenFileWaitMs = (
  now: number,
  previousRequestAt: number,
  limitedUntil: number,
  intervalMs = minIntervalMs
): number => Math.max(0, previousRequestAt + intervalMs - now, limitedUntil - now);

/**
 * Wait for this request's turn on its lane. `onWait` hears how long, before
 * the wait starts, so a long one can be shown rather than looking stuck.
 */
export const paceLibgenFile = async (
  lane = DIRECT_LANE,
  onWait?: (waitMs: number, cooling: boolean) => void
): Promise<void> => {
  const state = laneState(lane);
  const now = Date.now();
  const waitMs = libgenFileWaitMs(now, state.lastRequestAt, state.cooldownUntil, state.intervalMs);
  // Claim the slot before waiting, so callers arriving together space out
  // instead of all reading the same stale timestamp and going out at once.
  state.lastRequestAt = Math.max(now, state.lastRequestAt + state.intervalMs, state.cooldownUntil);

  if (waitMs > 0) {
    // Whether it is the limit's cooldown or only the lane's spacing.
    onWait?.(waitMs, state.cooldownUntil > now);
    await delay(waitMs);
  }
};

/** Refused under the file limit: this lane asks less often from now on. */
export const slowLibgenLane = (lane = DIRECT_LANE): void => {
  const state = laneState(lane);
  state.intervalMs = Math.min(
    Math.max(state.intervalMs, minIntervalMs) * 1.5,
    Math.max(LIBGEN_FILE_MAX_INTERVAL_MS, minIntervalMs)
  );
};

/** A file request went through: ease this lane's spacing back a little. */
export const noteLibgenFileStarted = (lane = DIRECT_LANE): void => {
  const state = laneState(lane);
  state.intervalMs = Math.max(minIntervalMs, state.intervalMs - 1000);
};

/** This lane's current spacing between file requests. */
export const libgenLaneIntervalMs = (lane = DIRECT_LANE): number => laneState(lane).intervalMs;

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
