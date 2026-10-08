import { afterEach, describe, expect, it } from "bun:test";
import {
  libgenLaneRefusals,
  resetLibgenLane,
  slowLibgenLane,
} from "../src/api/data/libgen-file-pacing";
import type { DownloadLane } from "../src/api/data/download";
import { LaneService } from "../src/server/lane-service";
import { mockFetch } from "./support/fetch-mock";

const MAIN: DownloadLane = { key: "FI-1" };
const DK = { key: "DK-1", proxy: "http://172.30.0.12:8888" };
const NL = { key: "NL-1", proxy: "http://172.30.0.16:8888" };

const answerProbes = (answers: Record<string, string>) =>
  mockFetch(async (_input, init) => {
    const proxy = (init as { proxy?: string } | undefined)?.proxy ?? "";
    const lane = [MAIN, DK, NL].find((candidate) => (candidate.proxy ?? "") === proxy);
    const answer = answers[lane?.key ?? ""];
    if (!answer) {
      throw new Error("tunnel down");
    }
    return new Response(`fl=1\n${answer}\n`);
  });

const recorder = () => {
  const rotated: string[] = [];
  return { rotated, rotate: async (lane: DownloadLane) => void rotated.push(lane.key) };
};

describe("lane controls", () => {
  afterEach(() => {
    for (const lane of [MAIN, DK, NL]) {
      resetLibgenLane(lane.key);
    }
  });

  it("reports each lane's exit country beside its IP", async () => {
    answerProbes({ "FI-1": "ip=1.1.1.1\nloc=FI", "DK-1": "ip=2.2.2.2\nloc=DK" });
    const lanes = new LaneService([MAIN, DK, NL]);
    await lanes.probe();

    const [main, dk, nl] = lanes.getStates();
    expect([main?.ip, main?.country]).toEqual(["1.1.1.1", "FI"]);
    expect([dk?.ip, dk?.country]).toEqual(["2.2.2.2", "DK"]);
    expect(nl?.ready).toBe(false);
    expect(nl?.downSince).not.toBe("");
  });

  it("reconnects one lane by hand, however recently it last moved", async () => {
    answerProbes({ "FI-1": "ip=1.1.1.1", "DK-1": "ip=2.2.2.2", "NL-1": "ip=3.3.3.3" });
    const { rotated, rotate } = recorder();
    const lanes = new LaneService([MAIN, DK, NL], { rotate });
    await lanes.probe();

    expect(await lanes.reconnect("DK-1")).toEqual({ ok: true });
    expect(await lanes.reconnect("DK-1")).toEqual({ ok: true });
    expect(rotated).toEqual(["DK-1", "DK-1"]);
    const dk = lanes.getStates().find((lane) => lane.key === "DK-1");
    expect(dk?.ready).toBe(false);
    expect(dk?.lastRotation?.reason).toBe("reconnected by hand");
  });

  it("says why a lane could not be reconnected", async () => {
    const lanes = new LaneService([MAIN, DK], {
      rotate: async () => {
        throw new Error("gluetun answered 401");
      },
    });

    expect(await lanes.reconnect("DK-1")).toEqual({ ok: false, error: "gluetun answered 401" });
    expect(await lanes.reconnect("XX-9")).toEqual({ ok: false, error: "no lane XX-9" });
    expect(lanes.getStates()[1]?.lastRotation?.error).toBe("gluetun answered 401");
  });

  it("cannot reconnect anything without a control key", async () => {
    const lanes = new LaneService([MAIN, DK]);
    expect(lanes.canReconnect(DK)).toBe(false);
    const result = await lanes.reconnect("DK-1");
    expect(result.ok).toBe(false);
  });

  it("the main lane is reconnectable only when the app can reach its control server", async () => {
    const { rotate } = recorder();
    expect(new LaneService([MAIN, DK], { rotate }).canReconnect(MAIN)).toBe(false);
    expect(new LaneService([MAIN, DK], { rotate, mainControllable: true }).canReconnect(MAIN)).toBe(
      true
    );
  });

  it("reconnects every lane it can at once", async () => {
    const { rotated, rotate } = recorder();
    const lanes = new LaneService([MAIN, DK, NL], { rotate });

    const results = await lanes.reconnectAll();

    expect(rotated).toHaveLength(2);
    expect(rotated).toContain("DK-1");
    expect(rotated).toContain("NL-1");
    expect(Object.keys(results)).toHaveLength(2);
  });

  it("leaves lanes where they are while automatic rotation is off", async () => {
    answerProbes({ "FI-1": "ip=1.1.1.1", "DK-1": "ip=2.2.2.2", "NL-1": "ip=3.3.3.3" });
    const { rotated, rotate } = recorder();
    const lanes = new LaneService([MAIN, DK, NL], { rotate, refusals: libgenLaneRefusals });
    lanes.setAutoRotate(false);
    for (let refusal = 0; refusal < 3; refusal++) {
      slowLibgenLane(DK.key);
    }

    await lanes.probe();
    expect(rotated).toEqual([]);

    lanes.setAutoRotate(true);
    await lanes.probe();
    expect(rotated).toEqual(["DK-1"]);
  });
});
