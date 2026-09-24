import type { DownloadLane } from "../api/data/download";

/** Answers with the caller's address as `ip=…`, which is what names a lane. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const PROBE_TIMEOUT_MS = 20_000;
/** How long a lane sits out after LibGen stopped answering through it. */
const BENCH_MS = 5 * 60_000;

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

  constructor(readonly lanes: DownloadLane[]) {
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
    return results.some(Boolean);
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
