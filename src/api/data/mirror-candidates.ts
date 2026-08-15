import { getAdapter } from "../adapters";
import { Adapter } from "../adapters/adapter";
import { Mirror } from "./config";
import { MirrorCandidate } from "./resolve";

export interface MirrorCandidateArguments {
  mirrors: Mirror[];
  activeMirror?: Mirror;
  activeAdapter?: Adapter;
  // Last mirror that actually served a file.
  preferredMirrorSource?: string;
  // Mirrors that went dark during this run.
  unreachableMirrorSources?: string[];
}

/**
 * Orders the mirrors a lookup or download should try: the one that last served
 * a file, then the active one, then the rest. MD5s in one list usually come
 * from a single catalogue, so trying the proven mirror first keeps the per item
 * probe cost of a long list close to zero.
 *
 * Shared by the TUI store and the server so the failover order is defined once.
 */
export const buildMirrorCandidates = ({
  mirrors,
  activeMirror,
  activeAdapter,
  preferredMirrorSource,
  unreachableMirrorSources = [],
}: MirrorCandidateArguments): MirrorCandidate[] => {
  const orderedMirrors: Mirror[] = [];
  const pushMirror = (mirror: Mirror | undefined) => {
    if (!mirror) {
      return;
    }

    if (orderedMirrors.some((existing) => existing.src === mirror.src)) {
      return;
    }

    orderedMirrors.push(mirror);
  };

  pushMirror(mirrors.find((mirror) => mirror.src === preferredMirrorSource));
  pushMirror(activeMirror);
  for (const mirror of mirrors) {
    pushMirror(mirror);
  }

  const candidates: MirrorCandidate[] = [];
  for (const mirror of orderedMirrors) {
    if (mirror.src === activeMirror?.src && activeAdapter) {
      candidates.push({ mirror, adapter: activeAdapter });
      continue;
    }

    try {
      candidates.push({ mirror, adapter: getAdapter(mirror.src, mirror.type) });
    } catch {
      // A mirror type this build doesn't know about is simply not a candidate.
    }
  }

  const reachableCandidates = candidates.filter(
    (candidate) => !unreachableMirrorSources.includes(candidate.mirror.src)
  );

  // Everything failed at some point during this run. Trying them all again
  // beats failing every remaining item outright.
  if (reachableCandidates.length === 0) {
    return candidates;
  }

  return reachableCandidates;
};
