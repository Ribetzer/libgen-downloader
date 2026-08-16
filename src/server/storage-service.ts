import fs from "node:fs";
import path from "node:path";
import { VOLUME_CHECK_TTL_MS } from "../settings";

export interface StorageState {
  ready: boolean;
  reason: string;
}

interface StorageServiceArguments {
  directory: string;
  /** Filename that must be readable inside `directory`; empty disables the check. */
  marker: string;
}

/**
 * Answers whether the output directory is really the disk it is supposed to be.
 *
 * The failure worth catching is not a missing mount but a *phantom* one: when a
 * removable disk is absent, Docker will happily create the bind-mount target,
 * and WSL2 can hold a stale mount point. Either way the container gets an empty,
 * writable directory that reaches no disk, so a write test passes and the
 * downloads are lost with it. A marker file the real volume carries cannot be
 * faked that way.
 *
 * The check is off unless a marker is configured, so an ordinary local or NAS
 * setup behaves exactly as before.
 */
export class StorageService {
  private directory: string;
  private marker: string;
  private cached: StorageState | undefined;
  private checkedAt = 0;

  constructor({ directory, marker }: StorageServiceArguments) {
    this.directory = directory;
    this.marker = marker;
  }

  private async probe(): Promise<StorageState> {
    if (!this.marker) {
      return { ready: true, reason: "" };
    }

    const markerPath = path.join(this.directory, this.marker);

    try {
      await fs.promises.access(markerPath, fs.constants.R_OK);
      return { ready: true, reason: "" };
    } catch {
      return {
        ready: false,
        reason:
          `${this.directory} is missing its ${this.marker} marker, so it is not the ` +
          "expected volume. Downloads are paused until it comes back.",
      };
    }
  }

  /** Cached briefly: the queue asks once per item, not once per chunk. */
  async getState(): Promise<StorageState> {
    const now = Date.now();
    if (this.cached && now - this.checkedAt < VOLUME_CHECK_TTL_MS) {
      return this.cached;
    }

    this.cached = await this.probe();
    this.checkedAt = now;
    return this.cached;
  }

  async isReady(): Promise<boolean> {
    const state = await this.getState();
    return state.ready;
  }

  /** Drops the cache so a plugged-in disk is noticed without waiting it out. */
  forget(): void {
    this.cached = undefined;
    this.checkedAt = 0;
  }
}
