import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  libgenLaneRefusals,
  resetLibgenLane,
  slowLibgenLane,
} from "../src/api/data/libgen-file-pacing";
import type { DownloadLane } from "../src/api/data/download";
import { gluetunControlURL } from "../src/server/gluetun-control";
import { LaneService, ROTATE_DOWN_MS, ROTATE_MIN_GAP_MS } from "../src/server/lane-service";
import { mockFetch } from "./support/fetch-mock";

const MAIN: DownloadLane = { key: "FI-1" };
const DK = { key: "DK-1", proxy: "http://172.30.0.12:8888" };
const NL = { key: "NL-1", proxy: "http://172.30.0.16:8888" };

/** Every probe through a lane answers with the IP given for it. */
const answerProbes = (ips: Record<string, string>) =>
  mockFetch(async (_input, init) => {
    const proxy = (init as { proxy?: string } | undefined)?.proxy ?? "";
    const lane = [MAIN, DK, NL].find((candidate) => (candidate.proxy ?? "") === proxy);
    const ip = ips[lane?.key ?? ""];
    if (!ip) {
      throw new Error("tunnel down");
    }
    return new Response(`fl=1\nip=${ip}\nloc=FI\n`);
  });

const rotating = () => {
  const rotated: string[] = [];
  const rotate = async (lane: DownloadLane) => {
    rotated.push(lane.key);
  };
  return { rotated, rotate };
};

describe("lane rotation", () => {
  afterEach(() => {
    spyOn(Date, "now").mockRestore();
    for (const lane of [MAIN, DK, NL]) {
      resetLibgenLane(lane.key);
    }
  });

  it("moves a lane that LibGen keeps refusing, and only that one", async () => {
    answerProbes({ "FI-1": "1.1.1.1", "DK-1": "2.2.2.2", "NL-1": "3.3.3.3" });
    const { rotated, rotate } = rotating();
    const lanes = new LaneService([MAIN, DK, NL], { rotate, refusals: libgenLaneRefusals });

    for (let refusal = 0; refusal < 3; refusal++) {
      slowLibgenLane(DK.key);
    }
    await lanes.probe();

    expect(rotated).toEqual(["DK-1"]);
    // Out of use until a probe sees it up on its new server.
    expect(lanes.isReady(DK)).toBe(false);
  });

  it("moves a lane that landed on another lane's exit IP", async () => {
    answerProbes({ "FI-1": "1.1.1.1", "DK-1": "2.2.2.2", "NL-1": "2.2.2.2" });
    const { rotated, rotate } = rotating();
    const lanes = new LaneService([MAIN, DK, NL], { rotate });

    await lanes.probe();

    expect(rotated).toEqual(["NL-1"]);
  });

  it("moves a lane whose tunnel has not answered for a while, but not at once", async () => {
    answerProbes({ "FI-1": "1.1.1.1", "DK-1": "2.2.2.2" });
    const { rotated, rotate } = rotating();
    const lanes = new LaneService([MAIN, DK, NL], { rotate });
    const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    await lanes.probe();
    expect(rotated).toEqual([]);

    now.mockReturnValue(1_800_000_000_000 + ROTATE_DOWN_MS);
    await lanes.probe();
    expect(rotated).toEqual(["NL-1"]);
  });

  it("never moves the same lane again before the gap has passed", async () => {
    answerProbes({ "FI-1": "1.1.1.1", "DK-1": "2.2.2.2", "NL-1": "2.2.2.2" });
    const { rotated, rotate } = rotating();
    const lanes = new LaneService([MAIN, DK, NL], { rotate });
    const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    await lanes.probe();
    await lanes.probe();
    expect(rotated).toEqual(["NL-1"]);

    now.mockReturnValue(1_800_000_000_000 + ROTATE_MIN_GAP_MS);
    await lanes.probe();
    expect(rotated).toEqual(["NL-1", "NL-1"]);
  });

  it("does nothing without a way to rotate, and never touches the main lane", async () => {
    answerProbes({ "FI-1": "2.2.2.2", "DK-1": "2.2.2.2", "NL-1": "3.3.3.3" });
    const { rotated, rotate } = rotating();

    await new LaneService([MAIN, DK, NL]).probe();
    await new LaneService([MAIN, DK, NL], { rotate }).probe();

    // The main lane was seen first, so the proxied lane sharing its IP moves.
    expect(rotated).toEqual(["DK-1"]);
  });
});

describe("refusals and reset", () => {
  it("counts refusals within the window, and a reset forgets them", () => {
    slowLibgenLane("X");
    slowLibgenLane("X");
    expect(libgenLaneRefusals("X", 60_000)).toBe(2);

    resetLibgenLane("X");
    expect(libgenLaneRefusals("X", 60_000)).toBe(0);
  });
});

describe("gluetunControlURL", () => {
  it("is the proxy's host on gluetun's control port", () => {
    expect(gluetunControlURL("http://172.30.0.12:8888")).toBe("http://172.30.0.12:8000");
  });
});
