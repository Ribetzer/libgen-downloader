import {
  EditionRecord,
  FileDetails,
  getEditionFileIds,
  parseEditionsJSON,
  parseFileDetailsJSON,
} from "./edition";
import { getDocument, getJSON } from "./document";
import type { ParsedQuery } from "./query";
import { MirrorCandidate } from "./resolve";
import { ISSUE_PAGE_SIZE, MAX_ISSUE_PAGES, PROBE_REQ_ATTEMPT_COUNT } from "../../settings";
import { attempt } from "../../utilities";

export type LookupResult =
  | { status: "found"; records: EditionRecord[]; candidate: MirrorCandidate }
  // Every mirror answered and none of them knows this record.
  | { status: "not_found"; checkedMirrors: string[] }
  // Nothing answered, so the record may well exist.
  | { status: "unreachable"; checkedMirrors: string[] };

interface LookupArguments {
  candidates: MirrorCandidate[];
  onMirrorTry?: (mirrorSource: string) => void;
  onMirrorUnreachable?: (mirrorSource: string) => void;
}

/**
 * Walks the candidate mirrors, running `load` against each until one returns
 * records. Shared by the DOI and issue lookups so both behave like the MD5
 * resolver: a miss on one mirror is not the end of the story.
 */
const lookupAcrossMirrors = async (
  { candidates, onMirrorTry, onMirrorUnreachable }: LookupArguments,
  load: (candidate: MirrorCandidate) => Promise<EditionRecord[]>
): Promise<LookupResult> => {
  const checkedMirrors: string[] = [];
  let reachedAnyMirror = false;

  for (const candidate of candidates) {
    const mirrorSource = candidate.mirror.src;
    checkedMirrors.push(mirrorSource);

    if (onMirrorTry) {
      onMirrorTry(mirrorSource);
    }

    const records = await attempt(() => load(candidate), undefined, undefined, undefined, {
      attempts: PROBE_REQ_ATTEMPT_COUNT,
    });

    if (!records) {
      if (onMirrorUnreachable) {
        onMirrorUnreachable(mirrorSource);
      }
      continue;
    }

    reachedAnyMirror = true;

    if (records.length > 0) {
      return { status: "found", records, candidate };
    }
  }

  if (reachedAnyMirror) {
    return { status: "not_found", checkedMirrors };
  }

  return { status: "unreachable", checkedMirrors };
};

/**
 * Extension and size live on the file record rather than the edition, so the
 * result list fills them in with one batched call. Best effort: a failure here
 * costs a couple of columns, not the search.
 */
export const lookupFileDetails = async (
  candidate: MirrorCandidate,
  records: EditionRecord[]
): Promise<Map<string, FileDetails>> => {
  const fileIds = getEditionFileIds(records);
  if (fileIds.length === 0) {
    return new Map();
  }

  const payload = await attempt(
    () => getJSON(candidate.adapter.getFilesByIdsURL(fileIds)),
    undefined,
    undefined,
    undefined,
    { attempts: PROBE_REQ_ATTEMPT_COUNT }
  );

  return parseFileDetailsJSON(payload);
};

export const lookupEditionByDOI = async (
  doi: string,
  lookupArguments: LookupArguments
): Promise<LookupResult> => {
  return lookupAcrossMirrors(lookupArguments, async (candidate) => {
    const payload = await getJSON(candidate.adapter.getEditionByDOIURL(doi));
    return parseEditionsJSON(payload);
  });
};

/**
 * Routes a classified query to the lookup it needs. Shared by the TUI store and
 * the web server so both treat a DOI and an issue identically.
 */
export const runQueryLookup = async (
  parsedQuery: Exclude<ParsedQuery, { kind: "text" }>,
  lookupArguments: LookupArguments
): Promise<LookupResult> => {
  if (parsedQuery.kind === "doi") {
    return lookupEditionByDOI(parsedQuery.doi, lookupArguments);
  }

  return lookupIssueEditions({
    issuesId: parsedQuery.issuesId,
    volume: parsedQuery.volume,
    ...lookupArguments,
  });
};

interface IssueLookupArguments extends LookupArguments {
  issuesId: string;
  volume?: string;
  onPage?: (pageNumber: number, editionCount: number) => void;
}

/**
 * Collects a whole issue (or a whole periodical when no volume is given). The
 * editions tab pages like the file search does, so pages are followed until one
 * comes back short or the cap is hit.
 */
export const lookupIssueEditions = async ({
  issuesId,
  volume,
  onPage,
  ...lookupArguments
}: IssueLookupArguments): Promise<LookupResult> => {
  return lookupAcrossMirrors(lookupArguments, async (candidate) => {
    const records: EditionRecord[] = [];
    const seenEditionIds = new Set<string>();

    for (let pageNumber = 1; pageNumber <= MAX_ISSUE_PAGES; pageNumber++) {
      const searchURL = candidate.adapter.getIssueSearchURL({
        issuesId,
        volume,
        pageNumber,
        pageSize: ISSUE_PAGE_SIZE,
      });

      const pageResult = await getDocument(searchURL);
      const editionIds = candidate.adapter
        .parseEditionIds(pageResult.document)
        .filter((editionId) => !seenEditionIds.has(editionId));

      if (editionIds.length === 0) {
        break;
      }

      for (const editionId of editionIds) {
        seenEditionIds.add(editionId);
      }

      const payload = await getJSON(candidate.adapter.getEditionsByIdsURL(editionIds));
      records.push(...parseEditionsJSON(payload));

      if (onPage) {
        onPage(pageNumber, records.length);
      }

      if (editionIds.length < ISSUE_PAGE_SIZE) {
        break;
      }
    }

    return records;
  });
};
