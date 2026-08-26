import { SEARCH_PAGE_SIZE } from "../../settings";
import { attempt } from "../../utilities";
import { getDocument } from "../data/document";
import { normalizeDOI } from "../data/edition";
import { buildEntriesFromEditions } from "../data/edition-entry";
import { lookupFileDetails, runQueryLookup } from "../data/lookup";
import { getMD5FromURL } from "../data/md5";
import type { ParsedQuery } from "../data/query";
import type { Entry } from "../models/entry";
import type { Source, SourceContext, SourceOutcome, SourceResult } from "./index";

/**
 * LibGen as a source. The behaviour is exactly what `runSearch` did before
 * there was more than one library - the HTML file search for text, the JSON
 * API for a DOI or an issue - only now behind the same interface arXiv and
 * Sci-Hub implement, so the server can ask all three the same way.
 */

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

/**
 * A LibGen entry is identified by its MD5 and by nothing else, so a row
 * without one cannot be queued and is dropped. It carries no `downloadURL`:
 * the file's location is whichever mirror answers at download time, which is
 * what `resolveDownloadURL` is for.
 */
export const toResults = (entries: Entry[]): SourceResult[] => {
  const items: SourceResult[] = [];

  for (const entry of entries) {
    const md5 = getMD5FromURL(entry.mirror);
    if (!md5) {
      continue;
    }

    items.push({
      ...entry,
      source: "libgen",
      md5,
      downloadURL: "",
      articleTitle: readArticleTitle(entry.title),
      doi: readDOI(entry),
    });
  }

  return items;
};

const searchByLookup = async (
  parsedQuery: Exclude<ParsedQuery, { kind: "text" }>,
  context: SourceContext
): Promise<SourceOutcome> => {
  const result = await runQueryLookup(parsedQuery, {
    candidates: context.candidates,
    onMirrorUnreachable: context.onMirrorUnreachable,
  });

  if (result.status !== "found") {
    return { status: "ok", items: [] };
  }

  const fileDetails = await lookupFileDetails(result.candidate, result.records);
  const entries = buildEntriesFromEditions(result.records, fileDetails, result.candidate.adapter);

  return { status: "ok", items: toResults(entries) };
};

const searchByText = async (
  query: string,
  page: number,
  context: SourceContext
): Promise<SourceOutcome> => {
  const { adapter } = context;
  if (!adapter) {
    return { status: "error", message: "No mirror available" };
  }

  const searchURL = adapter.getSearchURL(query, page, SEARCH_PAGE_SIZE);
  const pageResult = await attempt(() => getDocument(searchURL));

  if (!pageResult) {
    return { status: "error", message: `Couldn't fetch the search page for "${query}"` };
  }

  const connectionError = adapter.detectConnectionError(pageResult.document);
  if (connectionError) {
    return { status: "error", message: connectionError };
  }

  const entries = adapter.parseEntries(pageResult.document);
  if (!entries) {
    return { status: "error", message: `Couldn't parse the search page for "${query}"` };
  }

  // The list rows carry a relative detail path; make it absolute so the md5
  // survives the trip to the browser and back.
  const absoluteEntries = entries.map((entry) => ({
    ...entry,
    mirror: adapter.getPageURL(entry.mirror),
  }));

  return { status: "ok", items: toResults(absoluteEntries) };
};

export const libgenSource: Source = {
  id: "libgen",
  label: "LibGen",
  // The only source that answers all three query kinds.
  handles: () => true,
  async search(parsedQuery, page, context) {
    if (context.candidates.length === 0) {
      return { status: "error", message: "No mirror available" };
    }

    // A DOI or an issue expression is not findable in the files table, so both
    // go to the JSON API instead of the HTML search.
    if (parsedQuery.kind !== "text") {
      return searchByLookup(parsedQuery, context);
    }

    return searchByText(parsedQuery.query, page, context);
  },
};
