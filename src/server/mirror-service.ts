import { getAdapter } from "../api/adapters";
import { Adapter } from "../api/adapters/adapter";
import { Config, fetchConfig, findMirror, Mirror } from "../api/data/config";
import { buildMirrorCandidates } from "../api/data/mirror-candidates";
import { MirrorCandidate } from "../api/data/resolve";
import { attempt } from "../utilities";

export interface MirrorState {
  mirror?: Mirror;
  mirrors: Mirror[];
  latestVersion: string;
  preferredMirrorSource?: string;
  unreachableMirrorSources: string[];
  lastRefreshedAt?: string;
  lastError?: string;
}

/**
 * Holds what the TUI's config slice holds — the mirror list, the active mirror
 * and the two memos that drive failover — for a process with no store behind
 * it. A refresh failure is recorded rather than thrown, so the server keeps
 * answering and the UI can show why nothing is downloading.
 */
export class MirrorService {
  private state: MirrorState = { mirrors: [], latestVersion: "", unreachableMirrorSources: [] };
  private adapter: Adapter | undefined;

  getState(): MirrorState {
    return { ...this.state, unreachableMirrorSources: [...this.state.unreachableMirrorSources] };
  }

  getAdapter(): Adapter | undefined {
    return this.adapter;
  }

  /**
   * Pins the service to a known mirror list without consulting the remote
   * config. Used when the mirrors are already known, and by the tests.
   */
  use(mirrors: Mirror[], activeMirror: Mirror): void {
    this.adapter = getAdapter(activeMirror.src, activeMirror.type);
    this.state = {
      ...this.state,
      mirrors,
      mirror: activeMirror,
      unreachableMirrorSources: [],
      lastError: undefined,
    };
  }

  async refresh(): Promise<boolean> {
    const config: Config | undefined = await attempt(fetchConfig);

    if (!config) {
      this.state = { ...this.state, lastError: "Couldn't fetch the configuration file" };
      return false;
    }

    const failedMirrors: string[] = [];
    const mirror = await findMirror(config.mirrors, (failedMirror) => {
      failedMirrors.push(failedMirror);
    });

    if (!mirror) {
      this.state = {
        ...this.state,
        mirrors: config.mirrors,
        latestVersion: config.latestVersion,
        mirror: undefined,
        lastError: `Couldn't reach any mirror (${failedMirrors.join(", ")})`,
      };
      this.adapter = undefined;
      return false;
    }

    this.adapter = getAdapter(mirror.src, mirror.type);
    this.state = {
      ...this.state,
      mirror,
      mirrors: config.mirrors,
      latestVersion: config.latestVersion,
      // A fresh look at the world: mirrors that were down may be back.
      unreachableMirrorSources: [],
      lastRefreshedAt: new Date().toISOString(),
      lastError: undefined,
    };

    return true;
  }

  getCandidates(): MirrorCandidate[] {
    return buildMirrorCandidates({
      mirrors: this.state.mirrors,
      activeMirror: this.state.mirror,
      activeAdapter: this.adapter,
      preferredMirrorSource: this.state.preferredMirrorSource,
      unreachableMirrorSources: this.state.unreachableMirrorSources,
    });
  }

  notePreferred(mirrorSource: string): void {
    this.state.preferredMirrorSource = mirrorSource;
    this.state.unreachableMirrorSources = this.state.unreachableMirrorSources.filter(
      (source) => source !== mirrorSource
    );
  }

  markUnreachable(mirrorSource: string): void {
    if (this.state.unreachableMirrorSources.includes(mirrorSource)) {
      return;
    }

    this.state.unreachableMirrorSources.push(mirrorSource);
  }
}
