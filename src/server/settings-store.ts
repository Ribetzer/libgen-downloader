import fs from "node:fs";

/**
 * What can be changed from the settings page while the server runs: how many
 * downloads run at once, whether lanes LibGen keeps refusing are moved to
 * another server by themselves, and whether the queue is paused. The
 * environment (`LIBGEN_CONCURRENCY`, `LIBGEN_GLUETUN_API_KEY`) sets the
 * defaults; a change made on the page is kept in the config directory and
 * outlives a restart or a redeploy.
 */
export interface RuntimeSettings {
  concurrency: number;
  autoRotate: boolean;
  paused: boolean;
}

const MAX_CONCURRENCY = 64;

const check = (name: string, value: unknown): number | boolean => {
  if (name === "concurrency") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_CONCURRENCY
    ) {
      throw new Error(`concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`);
    }
    return value;
  }
  if (name === "autoRotate" || name === "paused") {
    if (typeof value !== "boolean") {
      throw new TypeError(`${name} must be true or false`);
    }
    return value;
  }
  throw new Error(`unknown setting ${name}`);
};

export class SettingsStore {
  constructor(
    private file: string,
    private defaults: RuntimeSettings
  ) {}

  private saved(): Record<string, unknown> {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      // Missing or damaged: the defaults stand.
    }
    return {};
  }

  read(): RuntimeSettings {
    const settings: Record<string, unknown> = { ...this.defaults };
    for (const [name, value] of Object.entries(this.saved())) {
      try {
        settings[name] = check(name, value);
      } catch {
        // A value that would be refused if saved now is ignored.
      }
    }
    return settings as unknown as RuntimeSettings;
  }

  /** Checks every value before writing any; throws with the reason. */
  update(changes: unknown): RuntimeSettings {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      throw new TypeError("expected an object of settings");
    }
    const checked = Object.fromEntries(
      Object.entries(changes).map(([name, value]) => [name, check(name, value)])
    );
    const kept = Object.fromEntries(
      Object.entries(this.saved()).filter(([name]) => name in this.defaults)
    );
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...kept, ...checked }, undefined, 2));
    fs.renameSync(temporary, this.file);
    return this.read();
  }
}
