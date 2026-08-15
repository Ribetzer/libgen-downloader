import { getDocument } from "../api/data/document";
import { buildEntriesFromEditions } from "../api/data/edition-entry";
import { lookupFileDetails, runQueryLookup } from "../api/data/lookup";
import { getMD5FromURL } from "../api/data/md5";
import { parseQuery } from "../api/data/query";
import { Entry } from "../api/models/entry";
import { SEARCH_PAGE_SIZE } from "../settings";
import { attempt } from "../utilities";
import { MirrorService } from "./mirror-service";

export interface SearchResultItem extends Entry {
  md5: string;
}

export type SearchOutcome =
  | { status: "ok"; kind: "text" | "doi" | "issue"; items: SearchResultItem[] }
  | { status: "error"; message: string };

const withMD5 = (entries: Entry[]): SearchResultItem[] => {
  const items: SearchResultItem[] = [];

  for (const entry of entries) {
    const md5 = getMD5FromURL(entry.mirror);
    if (!md5) {
      continue;
    }

    items.push({ ...entry, md5 });
  }

  return items;
};

/**
 * The same branch the TUI takes: plain text goes to the HTML file search, while
 * a DOI or an `issuesid:` expression goes to the JSON API, because neither is
 * findable in the files table. Both shapes reach the browser as entries.
 */
export const runSearch = async (
  mirrors: MirrorService,
  rawQuery: string,
  pageNumber: number
): Promise<SearchOutcome> => {
  const parsedQuery = parseQuery(rawQuery);
  const candidates = mirrors.getCandidates();

  if (candidates.length === 0) {
    return { status: "error", message: "No mirror available" };
  }

  if (parsedQuery.kind !== "text") {
    const lookupArguments = {
      candidates,
      onMirrorUnreachable: (mirrorSource: string) => mirrors.markUnreachable(mirrorSource),
    };

    const result = await runQueryLookup(parsedQuery, lookupArguments);

    if (result.status !== "found") {
      return { status: "ok", kind: parsedQuery.kind, items: [] };
    }

    const fileDetails = await lookupFileDetails(result.candidate, result.records);
    const entries = buildEntriesFromEditions(result.records, fileDetails, result.candidate.adapter);

    return { status: "ok", kind: parsedQuery.kind, items: withMD5(entries) };
  }

  const adapter = mirrors.getAdapter();
  if (!adapter) {
    return { status: "error", message: "No mirror available" };
  }

  const searchURL = adapter.getSearchURL(parsedQuery.query, pageNumber, SEARCH_PAGE_SIZE);
  const pageResult = await attempt(() => getDocument(searchURL));

  if (!pageResult) {
    return { status: "error", message: `Couldn't fetch the search page for "${rawQuery}"` };
  }

  const connectionError = adapter.detectConnectionError(pageResult.document);
  if (connectionError) {
    return { status: "error", message: connectionError };
  }

  const entries = adapter.parseEntries(pageResult.document);
  if (!entries) {
    return { status: "error", message: `Couldn't parse the search page for "${rawQuery}"` };
  }

  // The list rows carry a relative detail path; make it absolute so the md5
  // survives the trip to the browser and back.
  const absoluteEntries = entries.map((entry) => ({
    ...entry,
    mirror: adapter.getPageURL(entry.mirror),
  }));

  return { status: "ok", kind: "text", items: withMD5(absoluteEntries) };
};
