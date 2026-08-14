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
  onMirrorUnreachable,
}: ResolveDownloadURLArguments): Promise<ResolveResult> {
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
      () => getDocument(detailPageURL),
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
