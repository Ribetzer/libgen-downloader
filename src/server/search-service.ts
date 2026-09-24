import { parseQuery } from "../api/data/query";
import { searchSources, type Source, type SourceNote, type SourceResult } from "../api/sources";
import { arxivSource } from "../api/sources/arxiv";
import { libgenSource } from "../api/sources/libgen";
import { openAccessSource } from "../api/sources/open-access";
import { scihubSource } from "../api/sources/scihub";
import { MirrorService } from "./mirror-service";

/**
 * The libraries searched, in the order their results are listed. LibGen first
 * because it is the catalogue with the broadest coverage; the other two add to
 * it rather than compete with it.
 */
export const SOURCES: Source[] = [libgenSource, arxivSource, openAccessSource, scihubSource];

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
 * The files a DOI names, asking one source at a time in `SOURCES` order -
 * LibGen, then legal open-access copies, then Sci-Hub - and stopping at the
 * first that has one. Asking them all at once meant every lookup waited on
 * Sci-Hub too - which now answers automated requests with a captcha - so a
 * DOI LibGen had already found sat in "resolving" and the queue ran at half
 * its workers. `unanswered` says why any source asked gave no answer.
 */
export const findFilesForDOI = async (
  mirrors: MirrorService,
  doi: string,
  proxy?: string,
  sources: Source[] = SOURCES
): Promise<{ items: SearchResultItem[]; unanswered: string[] }> => {
  const unanswered: string[] = [];
  const ask = async (asked: Source[]) => {
    const outcome = await runSearch(mirrors, doi, 1, asked, proxy);
    if (outcome.status !== "ok") {
      unanswered.push(outcome.message);
      return [];
    }

    unanswered.push(...outcome.notes.map((note) => note.message));
    return outcome.items;
  };

  for (const source of sources) {
    const items = await ask([source]);
    if (items.length > 0) {
      return { items, unanswered };
    }
  }

  return { items: [], unanswered };
};

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
  sources: Source[] = SOURCES,
  /** A lane's proxy, for the sources whose limits are per IP; see `SourceContext`. */
  proxy?: string
): Promise<SearchOutcome> => {
  const parsedQuery = parseQuery(rawQuery);

  const { items, notes, asked } = await searchSources(sources, parsedQuery, pageNumber, {
    candidates: mirrors.getCandidates(),
    adapter: mirrors.getAdapter(),
    onMirrorUnreachable: (mirrorSource: string) => mirrors.markUnreachable(mirrorSource),
    proxy,
  });

  if (asked > 0 && notes.length === asked) {
    return { status: "error", message: notes.map((note) => note.message).join("; ") };
  }

  return { status: "ok", kind: parsedQuery.kind, items: withIdentity(items), notes };
};
