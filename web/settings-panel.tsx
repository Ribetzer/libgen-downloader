import { useCallback, useEffect, useState } from "react";

// The settings page: every VPN lane with its exit, pacing and what it has
// delivered, buttons to reconnect one lane or all of them, the queue's
// controls (pause, downloads at once, automatic rotation), and what the
// queue got done in the last hour and day. Changes apply at once and are kept
// in the config directory, so nothing here needs an environment variable or
// a redeploy.

interface LaneRow {
  key: string;
  proxied: boolean;
  ready: boolean;
  ip: string;
  country: string;
  checkedAt: string;
  downSince: string;
  benchedUntil: string;
  rotating: boolean;
  lastRotation?: { at: string; reason: string; ok: boolean; error?: string };
  canReconnect: boolean;
  spacingSeconds: number;
  cooldownUntil: string;
  refusals: number;
  workers: number;
  downloaded: number;
  failed: number;
  bytes: number;
}

interface LaneReport {
  autoRotate: boolean;
  canRotate: boolean;
  lanes: LaneRow[];
}

interface ActivityWindow {
  downloaded: number;
  failed: number;
  bytes: number;
  bySource: Record<string, number>;
}

interface Stats {
  byStatus: Record<string, number>;
  lastHour: ActivityWindow;
  lastDay: ActivityWindow;
  running: boolean;
  paused: boolean;
  concurrency: number;
  annasDomain: string;
  annasEnabled: boolean;
  startedAt: string;
}

interface Settings {
  concurrency: number;
  autoRotate: boolean;
  paused: boolean;
}

const REFRESH_MS = 5000;

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

const clock = (iso: string): string =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";

const ago = (iso: string): string => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** "FI" → 🇫🇮, from the two regional-indicator letters. */
const flag = (country: string): string =>
  /^[A-Z]{2}$/.test(country)
    ? String.fromCodePoint(...[...country].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
    : "";

const laneStatus = (lane: LaneRow): { text: string; ok: boolean } => {
  if (lane.rotating) return { text: "reconnecting…", ok: false };
  if (lane.downSince) return { text: `not answering since ${clock(lane.downSince)}`, ok: false };
  if (lane.benchedUntil) return { text: `benched until ${clock(lane.benchedUntil)}`, ok: false };
  if (!lane.ready) return { text: "waiting for a probe", ok: false };
  if (lane.cooldownUntil)
    return { text: `LibGen limit, waiting until ${clock(lane.cooldownUntil)}`, ok: true };
  return { text: "up", ok: true };
};

const routeLabel = (route: string, annasDomain: string): string => {
  if (route.includes(annasDomain)) return "Anna's Archive";
  const labels: Record<string, string> = {
    arxiv: "arXiv",
    scihub: "Sci-Hub",
    openaccess: "Open access",
    wiley: "Wiley TDM",
  };
  if (labels[route]) return labels[route];
  try {
    return new URL(route).host;
  } catch {
    return route;
  }
};

const ActivityColumn = ({
  title,
  activity,
  annasDomain,
}: {
  title: string;
  activity: ActivityWindow;
  annasDomain: string;
}) => {
  const routes = Object.entries(activity.bySource).sort((a, b) => b[1] - a[1]);
  return (
    <div className="stat-block">
      <h3>{title}</h3>
      <div className="stat-big">{activity.downloaded.toLocaleString("en-GB")}</div>
      <div className="hint">
        downloaded · {formatSize(activity.bytes)} · {activity.failed.toLocaleString("en-GB")} failed
      </div>
      {routes.length > 0 && (
        <ul className="routes">
          {routes.map(([route, count]) => (
            <li key={route}>
              <span>{routeLabel(route, annasDomain)}</span>
              <span>{count.toLocaleString("en-GB")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const SettingsPanel = ({ onChanged }: { onChanged: () => void }) => {
  const [lanes, setLanes] = useState<LaneReport | undefined>();
  const [stats, setStats] = useState<Stats | undefined>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [concurrencyDraft, setConcurrencyDraft] = useState("");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | undefined>();
  const [busyLanes, setBusyLanes] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [laneResponse, statsResponse, settingsResponse] = await Promise.all([
      fetch("/api/lanes"),
      fetch("/api/stats"),
      fetch("/api/settings"),
    ]);
    setLanes((await laneResponse.json()) as LaneReport);
    setStats((await statsResponse.json()) as Stats);
    const loaded = ((await settingsResponse.json()) as { settings: Settings }).settings;
    setSettings((previous) => {
      // Leave a half-typed number alone; only follow the server when it moved.
      if (!previous || previous.concurrency !== loaded.concurrency) {
        setConcurrencyDraft(String(loaded.concurrency));
      }
      return loaded;
    });
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (changes: Partial<Settings>) => {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    const body = (await response.json()) as { settings?: Settings; error?: string };
    if (!response.ok || !body.settings) {
      setMessage({ text: body.error || "the server refused", bad: true });
      return;
    }
    setSettings(body.settings);
    setConcurrencyDraft(String(body.settings.concurrency));
    setMessage({ text: "Saved - in effect now, and kept across restarts.", bad: false });
    onChanged();
    void load();
  };

  const reconnect = async (key?: string) => {
    const keys = key
      ? [key]
      : (lanes?.lanes ?? []).filter((lane) => lane.canReconnect).map((lane) => lane.key);
    setBusyLanes((previous) => new Set([...previous, ...keys]));
    setMessage({ text: key ? `Reconnecting ${key}…` : "Reconnecting every lane…", bad: false });
    try {
      const response = await fetch("/api/lanes/reconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(key ? { key } : {}),
      });
      const body = (await response.json()) as {
        results?: Record<string, { ok: boolean; error?: string }>;
      };
      const failures = Object.entries(body.results ?? {}).filter(([, result]) => !result.ok);
      if (failures.length > 0) {
        setMessage({
          text: failures.map(([lane, result]) => `${lane}: ${result.error}`).join("; "),
          bad: true,
        });
      } else {
        setMessage({
          text: "Reconnected. Each lane is back in use once a probe sees its new exit (within a minute).",
          bad: false,
        });
      }
    } finally {
      setBusyLanes((previous) => new Set([...previous].filter((lane) => !keys.includes(lane))));
      void load();
    }
  };

  const reconnectable = (lanes?.lanes ?? []).filter((lane) => lane.canReconnect).length;
  const active =
    (stats?.byStatus.queued ?? 0) +
    (stats?.byStatus.resolving ?? 0) +
    (stats?.byStatus.downloading ?? 0) +
    (stats?.byStatus.retrying ?? 0);

  return (
    <section className="settings-panel">
      <h2>Settings</h2>
      <div className="body">
        {message && <div className={message.bad ? "error" : "hint note"}>{message.text}</div>}

        <h3>Queue</h3>
        {settings && stats && (
          <div className="settings-grid">
            <div>
              <span className={`status-dot ${settings.paused ? "bad" : "ok"}`} />
              {settings.paused ? "Paused" : stats.running ? "Downloading" : "Idle"} ·{" "}
              {active.toLocaleString("en-GB")} waiting or in progress
              {stats.byStatus.failed
                ? ` · ${stats.byStatus.failed.toLocaleString("en-GB")} failed`
                : ""}
            </div>
            <div>
              <button className="small" onClick={() => void save({ paused: !settings.paused })}>
                {settings.paused ? "Resume downloads" : "Pause downloads"}
              </button>
              <span className="hint">
                {" "}
                Pausing lets what is downloading finish and takes nothing new.
              </span>
            </div>
            <label>
              Downloads at once{" "}
              <input
                type="number"
                min={1}
                max={64}
                value={concurrencyDraft}
                onChange={(event) => setConcurrencyDraft(event.target.value)}
              />{" "}
              <button
                className="small"
                disabled={Number(concurrencyDraft) === settings.concurrency}
                onClick={() => void save({ concurrency: Number(concurrencyDraft) })}
              >
                Save
              </button>
              <span className="hint">
                {" "}
                About two per lane ({(lanes?.lanes.length ?? 1) * 2} here) keeps each exit inside
                LibGen&apos;s limit.
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.autoRotate}
                disabled={!lanes?.canRotate}
                onChange={(event) => void save({ autoRotate: event.target.checked })}
              />{" "}
              Move a lane to another server by itself when LibGen keeps refusing it, it shares an
              exit with another lane, or it stops answering
              {!lanes?.canRotate && <span className="hint"> (needs LIBGEN_GLUETUN_API_KEY)</span>}
            </label>
          </div>
        )}

        <h3>
          Connections{" "}
          {reconnectable > 0 && (
            <button
              className="small"
              disabled={busyLanes.size > 0}
              onClick={() => void reconnect()}
            >
              Reconnect all
            </button>
          )}
        </h3>
        <div className="hint">
          Each lane is a Proton VPN connection with its own exit IP, and so its own allowance under
          LibGen&apos;s 15-files-in-5-minutes limit. Reconnecting picks another server in the same
          country. Counts are since the server started{stats ? ` (${ago(stats.startedAt)})` : ""}.
        </div>
        {lanes && (
          <div className="table-scroll">
            <table className="lanes-table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>Exit</th>
                  <th>Status</th>
                  <th className="num">Workers</th>
                  <th
                    className="num"
                    title="Seconds between file requests; grows when LibGen refuses"
                  >
                    Spacing
                  </th>
                  <th className="num" title="Refused under LibGen's limit in the last 30 minutes">
                    Refused
                  </th>
                  <th className="num">Done</th>
                  <th className="num">Failed</th>
                  <th className="num">Size</th>
                  <th>Last moved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lanes.lanes.map((lane) => {
                  const status = laneStatus(lane);
                  return (
                    <tr key={lane.key}>
                      <td className="nowrap">
                        <strong>{lane.key}</strong>
                        {!lane.proxied && <span className="hint"> main</span>}
                      </td>
                      <td
                        className="nowrap"
                        title={lane.checkedAt ? `probed ${ago(lane.checkedAt)}` : ""}
                      >
                        {flag(lane.country)} {lane.ip || "—"}
                      </td>
                      <td>
                        <span className={`status-dot ${status.ok ? "ok" : "bad"}`} />
                        {status.text}
                      </td>
                      <td className="num">{lane.workers}</td>
                      <td className="num">{lane.spacingSeconds}s</td>
                      <td className="num">{lane.refusals || ""}</td>
                      <td className="num">{lane.downloaded.toLocaleString("en-GB")}</td>
                      <td className="num">
                        {lane.failed ? lane.failed.toLocaleString("en-GB") : ""}
                      </td>
                      <td className="num">{lane.bytes ? formatSize(lane.bytes) : ""}</td>
                      <td
                        className="hint"
                        title={
                          lane.lastRotation
                            ? `${lane.lastRotation.reason}${lane.lastRotation.error ? ` - ${lane.lastRotation.error}` : ""}`
                            : ""
                        }
                      >
                        {lane.lastRotation
                          ? `${ago(lane.lastRotation.at)}${lane.lastRotation.ok ? "" : " (failed)"}`
                          : ""}
                      </td>
                      <td>
                        {lane.canReconnect && (
                          <button
                            className="small"
                            disabled={lane.rotating || busyLanes.has(lane.key)}
                            onClick={() => void reconnect(lane.key)}
                            title={
                              lane.proxied
                                ? ""
                                : "The app's own connection: downloads on it restart"
                            }
                          >
                            Reconnect
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {stats && (
          <>
            <h3>Activity</h3>
            <div className="stats-row">
              <ActivityColumn
                title="Last hour"
                activity={stats.lastHour}
                annasDomain={stats.annasDomain}
              />
              <ActivityColumn
                title="Last 24 hours"
                activity={stats.lastDay}
                annasDomain={stats.annasDomain}
              />
              <div className="stat-block">
                <h3>Everything</h3>
                <ul className="routes">
                  {Object.entries(stats.byStatus)
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, count]) => (
                      <li key={status}>
                        <span>{status}</span>
                        <span>{count.toLocaleString("en-GB")}</span>
                      </li>
                    ))}
                </ul>
                <div className="hint">
                  Anna&apos;s Archive fallback:{" "}
                  {stats.annasEnabled ? "on" : "off (no ANNAS_ARCHIVE_KEY)"}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
