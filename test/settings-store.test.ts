import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/server/settings-store";

const DEFAULTS = { concurrency: 16, autoRotate: true, paused: false };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "libgen-settings-"));
const file = path.join(directory, "settings.json");

afterEach(() => fs.rmSync(file, { force: true }));

describe("SettingsStore", () => {
  it("starts from the defaults the environment gave", () => {
    expect(new SettingsStore(file, DEFAULTS).read()).toEqual(DEFAULTS);
  });

  it("keeps a change across a restart", () => {
    new SettingsStore(file, DEFAULTS).update({ concurrency: 6, paused: true });
    expect(new SettingsStore(file, DEFAULTS).read()).toEqual({
      ...DEFAULTS,
      concurrency: 6,
      paused: true,
    });
  });

  it("refuses a bad value with a reason and saves nothing", () => {
    const settings = new SettingsStore(file, DEFAULTS);
    expect(() => settings.update({ concurrency: 0 })).toThrow(
      "concurrency must be a whole number from 1 to 64"
    );
    expect(() => settings.update({ autoRotate: "yes" })).toThrow(
      "autoRotate must be true or false"
    );
    expect(() => settings.update({ colour: "red" })).toThrow("unknown setting colour");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("ignores a damaged file rather than failing to start", () => {
    fs.writeFileSync(file, "{not json");
    expect(new SettingsStore(file, DEFAULTS).read()).toEqual(DEFAULTS);
    fs.writeFileSync(file, JSON.stringify({ concurrency: -3, autoRotate: false }));
    expect(new SettingsStore(file, DEFAULTS).read()).toEqual({ ...DEFAULTS, autoRotate: false });
  });
});
