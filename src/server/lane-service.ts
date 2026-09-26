import type { DownloadLane } from "../api/data/download";

/** Answers with the caller's address as `ip=…`, which is what names a lane. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const PROBE_TIMEOUT_MS = 20_000;
/** How long a lane sits out after LibGen stopped answering through it. */
const BENCH_MS = 5 * 60_000;

/**
 * When a proxied lane is moved to another server (`rotate`): refused under
 * LibGen's file limit this many times in ROTATE_WINDOW_MS, sharing an exit IP
 * with another lane, or not answering for ROTATE_DOWN_MS. Never more often
 * than ROTATE_MIN_GAP_MS for one lane, so a country whose every server is
 * busy is not cycled through without pause.
 */
export const ROTATE_REFUSALS = 3;
export const ROTATE_WINDOW_MS = 30 * 60_000;
export const ROTATE_DOWN_MS = 10 * 60_000;
export const ROTATE_MIN_GAP_MS = 20 * 60_000;

export interface LaneServiceOptions {
  /** Reconnects a lane's VPN, landing it on another server. Unset: never. */
  rotate?: (lane: DownloadLane) => Promise<void>;
  /** How often a lane was refused under the file limit within `withinMs`. */
  refusals?: (laneKey: string, withinMs: number) => number;
  /** A lane has been rotated: whatever was known about its old IP is stale. */
  onRotated?: (lane: DownloadLane) => void;
}

export interface LaneState {
  key: string;
  /** Whether it goes through another VPN connection's proxy. */
  proxied: boolean;
  ready: boolean;
  /** The address LibGen sees for this lane, once a probe has answered. */
  ip: string;
  checkedAt: string;
}

/**
 * `LIBGEN_PROXIES`, as `name=http://host:port` entries separated by commas.
 * A bare URL is named by its position. Names are what the UI and the retry
 * messages show, so a server's name ("DE-6") is the useful one to give.
 */
export const parseProxyList = (value: string): DownloadLane[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const separator = entry.indexOf("=");
      if (separator > 0 && !entry.slice(0, separator).includes("://")) {
        return { key: entry.slice(0, separator).trim(), proxy: entry.slice(separator + 1).trim() };
      }

      return { key: `proxy-${index + 1}`, proxy: entry };
    });

/**
 * Keeps track of which lanes can be used. A proxied lane is only as good as
 * the VPN connection behind it, and a dead one would otherwise fail every
 * item handed to it, so each is probed through its proxy and taken out of
 * rotation while it does not answer. The process's own connection is always
 * usable: if it is down nothing works, and the mirror check already says so.
 */
export class LaneService {
  private states = new Map<string, LaneState>();
  private benchedUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** When each lane stopped answering; cleared when it answers. */
  private downSince = new Map<string, number>();
  private rotatedAt = new Map<string, number>();
  private rotating = new Set<string>();

  constructor(
    readonly lanes: DownloadLane[],
    private options: LaneServiceOptions = {}
  ) {
    for (const lane of lanes) {
      this.states.set(lane.key, {
        key: lane.key,
        proxied: Boolean(lane.proxy),
        // Proxied lanes start out unproven, so nothing is sent down one that
        // has not answered yet.
        ready: !lane.proxy,
        ip: "",
        checkedAt: "",
      });
    }
  }

  isReady = (lane: DownloadLane): boolean =>
    (this.states.get(lane.key)?.ready ?? false) &&
    Date.now() >= (this.benchedUntil.get(lane.key) ?? 0);

  /**
   * Take a lane out of rotation for a while. Its tunnel can be up - the probe
   * says so - while LibGen refuses that exit IP, so this is separate from the
   * probe, and only expires with time.
   */
  bench = (lane: DownloadLane, ms = BENCH_MS): void => {
    this.benchedUntil.set(lane.key, Date.now() + ms);
    console.log(
      `Lane ${lane.key}: LibGen not answering through it, benched for ${ms / 60_000} min`
    );
  };

  getStates(): LaneState[] {
    return this.lanes.map((lane) => ({
      ...(this.states.get(lane.key) as LaneState),
      ready: this.isReady(lane),
    }));
  }

  /** Probes every lane at once. Resolves with whether any lane changed state. */
  async probe(): Promise<boolean> {
    const results = await Promise.all(this.lanes.map((lane) => this.probeLane(lane)));
    await this.rotateWhereNeeded();
    return results.some(Boolean);
  }

  /**
   * Moves lanes that are doing badly to another server. A Proton exit is
   * shared with strangers, so one IP can sit over LibGen's limit however
   * slowly we ask - and waiting that out, as the pacer does, gets nothing
   * done; a different server usually does. Only proxied lanes: the main one
   * carries the app's own connection.
   */
  private async rotateWhereNeeded(): Promise<void> {
    const { rotate, refusals } = this.options;
    if (!rotate) {
      return;
    }

    const now = Date.now();
    const seenIPs = new Map<string, string>();
    const due: { lane: DownloadLane; reason: string }[] = [];
    for (const lane of this.lanes) {
      const state = this.states.get(lane.key) as LaneState;
      let sharedWith: string | undefined;
      if (state.ready && state.ip) {
        sharedWith = seenIPs.get(state.ip);
      }
      if (state.ready && state.ip && !sharedWith) {
        seenIPs.set(state.ip, lane.key);
      }
      if (!lane.proxy || this.rotating.has(lane.key)) {
        continue;
      }
      if (now - (this.rotatedAt.get(lane.key) ?? 0) < ROTATE_MIN_GAP_MS) {
        continue;
      }

      const refused = refusals?.(lane.key, ROTATE_WINDOW_MS) ?? 0;
      const downFor = now - (this.downSince.get(lane.key) ?? now);
      if (sharedWith) {
        due.push({ lane, reason: `same exit IP as ${sharedWith}` });
      } else if (refused >= ROTATE_REFUSALS) {
        due.push({ lane, reason: `refused under LibGen's limit ${refused} times in 30 min` });
      } else if (downFor >= ROTATE_DOWN_MS) {
        due.push({ lane, reason: `not answering for ${Math.round(downFor / 60_000)} min` });
      }
    }

    await Promise.all(due.map(({ lane, reason }) => this.rotateLane(lane, reason)));
  }

  private async rotateLane(lane: DownloadLane, reason: string): Promise<void> {
    const { rotate, onRotated } = this.options;
    if (!rotate) {
      return;
    }

    this.rotating.add(lane.key);
    this.rotatedAt.set(lane.key, Date.now());
    const state = this.states.get(lane.key) as LaneState;
    // Out of rotation until a probe sees it up on its new server.
    state.ready = false;
    console.log(`Lane ${lane.key}: ${reason} - moving it to another server`);
    try {
      await rotate(lane);
      onRotated?.(lane);
    } catch (error: unknown) {
      console.log(`Lane ${lane.key}: could not reconnect (${(error as Error).message})`);
    } finally {
      this.rotating.delete(lane.key);
    }
  }

  private async probeLane(lane: DownloadLane): Promise<boolean> {
    const state = this.states.get(lane.key) as LaneState;
    let ip = "";
    try {
      const response = await fetch(TRACE_URL, {
        proxy: lane.proxy,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        ip = /^ip=(.+)$/m.exec(await response.text())?.[1]?.trim() ?? "";
      }
    } catch {
      // Unreachable proxy, or a tunnel that is not up yet.
    }

    // The process's own connection stays usable whatever the probe says.
    const ready = Boolean(ip) || !lane.proxy;
    const changed = ready !== state.ready || (ip !== "" && ip !== state.ip);
    if (changed) {
      let description = "not answering";
      if (ip) {
        description = `up, exit ${ip}`;
      }
      console.log(`Lane ${lane.key}: ${description}`);
    }

    state.ready = ready;
    if (ip) {
      state.ip = ip;
      this.downSince.delete(lane.key);
    } else if (!this.downSince.has(lane.key)) {
      this.downSince.set(lane.key, Date.now());
    }
    state.checkedAt = new Date().toISOString();
    return changed;
  }

  /**
   * Re-probes on an interval, calling `onTick` after every round - not only
   * when a probe changed something, because a benched lane comes back by the
   * clock, and nothing else would hand it a worker again.
   */
  watch(intervalMs: number, onTick: () => void): void {
    this.timer = setInterval(() => {
      void this.probe().then(onTick);
    }, intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
