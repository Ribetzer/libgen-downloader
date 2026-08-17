import { getDocument } from "../api/data/document";
import { normalizeDOI } from "../api/data/edition";
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
  /**
   * The article's own title. LibGen's file search puts the journal and issue
   * in `title` and appends the real title after a slash, so `title` alone
   * reads as "ACM Transactions on Graphics 2002-jul vol. 21 iss. 3 pp.339—346
   * / Dual contouring of Hermite data". Anything matching this against another
   * catalogue needs the second half.
   */
  articleTitle: string;
  /** The DOI, when LibGen's link carries one. Empty when it does not. */
  doi: string;
}

// LibGen's file search packs a whole record into one field, separated by
// slashes: "<journal> <issue details> / <article title> / DOI: <doi>". Both
// outer parts have to go for the middle to be usable as a title.
const ARTICLE_TITLE_SEPARATOR = " / ";
const DOI_SEGMENT_PATTERN = /^DOI:\s*/i;

/**
 * The article's own title, with the journal line and the trailing DOI removed.
 * A title containing its own slash survives, because only the known outer
 * segments are dropped rather than everything but one. Falls back to the whole
 * string, which is what a book or a JSON-API result already is.
 */
export const readArticleTitle = (title: string): string => {
  const segments = title.split(ARTICLE_TITLE_SEPARATOR);
  if (segments.length < 2) {
    return title.trim();
  }

  // First segment is the journal and issue; a trailing "DOI: …" is metadata.
  let middle = segments.slice(1);
  if (middle.length > 1 && DOI_SEGMENT_PATTERN.test(middle.at(-1)?.trim() || "")) {
    middle = middle.slice(0, -1);
  }

  return middle.join(ARTICLE_TITLE_SEPARATOR).trim() || title.trim();
};

/**
 * LibGen exposes the DOI three ways depending on the search path: appended to
 * the title as "DOI: …", hung off the detail link as `downloadname`, and in
 * `publisher` for JSON-API results (see `buildEntriesFromEditions`). All three
 * are tried and validated rather than trusted.
 */
export const readDOI = (entry: Entry): string => {
  for (const segment of entry.title.split(ARTICLE_TITLE_SEPARATOR)) {
    const trimmed = segment.trim();
    if (DOI_SEGMENT_PATTERN.test(trimmed)) {
      const normalized = normalizeDOI(trimmed.replace(DOI_SEGMENT_PATTERN, ""));
      if (normalized) {
        return normalized;
      }
    }
  }

  try {
    const fromLink = new URL(entry.mirror).searchParams.get("downloadname") || "";
    const normalized = normalizeDOI(fromLink);
    if (normalized) {
      return normalized;
    }
  } catch {
    // A relative or malformed link simply carries no DOI.
  }

  return normalizeDOI(entry.publisher || "") || "";
};

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

    items.push({
      ...entry,
      md5,
      articleTitle: readArticleTitle(entry.title),
      doi: readDOI(entry),
    });
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
