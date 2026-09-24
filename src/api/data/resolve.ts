import { Adapter } from "../adapters/adapter";
import { Mirror } from "./config";
import { getDocument } from "./document";
import { PROBE_REQ_ATTEMPT_COUNT } from "../../settings";
import { attempt } from "../../utilities";

export interface MirrorCandidate {
  mirror: Mirror;
  adapter: Adapter;
}

export type ResolveResult =
  | { status: "resolved"; downloadURL: string; candidate: MirrorCandidate }
  // Every mirror answered, none of them holds a record for this MD5.
  | { status: "not_found"; checkedMirrors: string[] }
  // No mirror could be reached at all, so the record may well exist.
  | { status: "unreachable"; checkedMirrors: string[] };

interface ResolveDownloadURLArguments {
  md5: string;
  candidates: MirrorCandidate[];
  onMirrorTry?: (mirrorSource: string) => void;
  onMirrorUnreachable?: (mirrorSource: string) => void;
  /** Fetch the detail pages through this proxy - the lane the file will use. */
  proxy?: string;
}

/**
 * Walks the candidate mirrors in order looking for one that can serve the MD5.
 * Each LibGen instance keeps its own catalogue, so a hash collected from one
 * mirror routinely has to be fetched from another.
 */
export async function resolveDownloadURL({
  md5,
  candidates,
  onMirrorTry,
  onMirrorUnreachable: reportUnreachable,
  proxy,
}: ResolveDownloadURLArguments): Promise<ResolveResult> {
  // A mirror that fails through a proxy may be failing because of the proxy.
  // Marking it unreachable would take it away from every lane, so only a
  // direct request is trusted to say so.
  let onMirrorUnreachable = reportUnreachable;
  if (proxy) {
    onMirrorUnreachable = undefined;
  }
  const checkedMirrors: string[] = [];
  let reachedAnyMirror = false;

  for (const candidate of candidates) {
    const mirrorSource = candidate.mirror.src;
    checkedMirrors.push(mirrorSource);

    if (onMirrorTry) {
      onMirrorTry(mirrorSource);
    }

    const detailPageURL = candidate.adapter.getDetailPageURL(md5);
    const detailPageResult = await attempt(
      () => getDocument(detailPageURL, { proxy }),
      undefined,
      undefined,
      undefined,
      { attempts: PROBE_REQ_ATTEMPT_COUNT }
    );

    if (!detailPageResult) {
      if (onMirrorUnreachable) {
        onMirrorUnreachable(mirrorSource);
      }
      continue;
    }

    const connectionError = candidate.adapter.detectConnectionError(detailPageResult.document);
    if (connectionError) {
      if (onMirrorUnreachable) {
        onMirrorUnreachable(mirrorSource);
      }
      continue;
    }

    reachedAnyMirror = true;

    const downloadURL = candidate.adapter.getMainDownloadURLFromDocument(detailPageResult.document);
    if (downloadURL) {
      return { status: "resolved", downloadURL, candidate };
    }
  }

  if (reachedAnyMirror) {
    return { status: "not_found", checkedMirrors };
  }

  return { status: "unreachable", checkedMirrors };
}
