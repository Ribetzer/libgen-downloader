import { parseQuery } from "../api/data/query";
import { searchSources, type Source, type SourceNote, type SourceResult } from "../api/sources";
import { arxivSource } from "../api/sources/arxiv";
import { libgenSource } from "../api/sources/libgen";
import { scihubSource } from "../api/sources/scihub";
import { MirrorService } from "./mirror-service";

/**
 * The libraries searched, in the order their results are listed. LibGen first
 * because it is the catalogue with the broadest coverage; the other two add to
 * it rather than compete with it.
 */
export const SOURCES: Source[] = [libgenSource, arxivSource, scihubSource];

export type SearchResultItem = SourceResult;

export type SearchOutcome =
  | {
      status: "ok";
      kind: "text" | "doi" | "issue";
      items: SearchResultItem[];
      /** Which sources came back empty-handed, and why. */
      notes: SourceNote[];
    }
  | { status: "error"; message: string };

/**
 * A result is usable if it can be downloaded, which means it needs either an
 * MD5 to resolve against the mirrors or a URL to fetch directly. This replaced
 * a filter that required an MD5, and so discarded every arXiv and Sci-Hub row
 * on the way to the browser.
 */
export const withIdentity = (items: SearchResultItem[]): SearchResultItem[] =>
  items.filter((item) => Boolean(item.md5) || Boolean(item.downloadURL));

/**
 * Asks every library that can answer, at once, and merges what comes back.
 *
 * One source failing is not a failed search: with arXiv unreachable, LibGen's
 * results still stand and the reason arXiv is missing travels alongside them
 * in `notes`. Only when *every* source that was asked has failed is there
 * nothing to show and an error to report.
 */
export const runSearch = async (
  mirrors: MirrorService,
  rawQuery: string,
  pageNumber: number,
  sources: Source[] = SOURCES
): Promise<SearchOutcome> => {
  const parsedQuery = parseQuery(rawQuery);

  const { items, notes, asked } = await searchSources(sources, parsedQuery, pageNumber, {
    candidates: mirrors.getCandidates(),
    adapter: mirrors.getAdapter(),
    onMirrorUnreachable: (mirrorSource: string) => mirrors.markUnreachable(mirrorSource),
  });

  if (asked > 0 && notes.length === asked) {
    return { status: "error", message: notes.map((note) => note.message).join("; ") };
  }

  return { status: "ok", kind: parsedQuery.kind, items: withIdentity(items), notes };
};
