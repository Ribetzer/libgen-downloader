import type { Adapter } from "../adapters/adapter";
import type { ParsedQuery } from "../data/query";
import type { MirrorCandidate } from "../data/resolve";
import type { Entry } from "../models/entry";
import { isSciHubPageHost, scihubRequestInit } from "./scihub";

/**
 * A library that can be searched, as distinct from a *mirror* of one.
 *
 * `Adapter` already abstracts over mirrors, but only over mirrors of the same
 * catalogue: every method on it - `parseEntries(document)`,
 * `getDetailPageURL(md5)`, `getMainDownloadURLFromDocument` - assumes LibGen's
 * HTML, LibGen's detail pages and LibGen's MD5s. arXiv answers Atom and has no
 * MD5 at all, so implementing `Adapter` for it would mean stubbing most of it
 * and lying about the rest.
 *
 * A source answers one question instead: given a query, what have you got?
 */

export type SourceId = "libgen" | "arxiv" | "scihub";

/**
 * A result from any library.
 *
 * There are two ways to identify a file and a row needs at least one:
 *
 * - `md5` names a *record*, not a location. `downloadByMD5` resolves it
 *   against whichever mirror answers, which is why LibGen rows carry no URL.
 * - `downloadURL` is the file itself. arXiv and Sci-Hub both hand one over
 *   directly and have no MD5 at any point.
 *
 * Empty string means absent, the same convention `doi` and the queue's own
 * columns already use.
 */
export interface SourceResult extends Entry {
  source: SourceId;
  md5: string;
  downloadURL: string;
  /**
   * The work's own title. LibGen's file search puts the journal and issue in
   * `title` and appends the real title after a slash, so `title` alone reads
   * as "ACM Transactions on Graphics 2002-jul vol. 21 iss. 3 pp.339-346 / Dual
   * contouring of Hermite data". Anything matching this against another
   * catalogue needs the second half. Sources whose title is already the title
   * simply repeat it.
   */
  articleTitle: string;
  doi: string;
}

export type SourceOutcome =
  | { status: "ok"; items: SourceResult[] }
  | { status: "error"; message: string };

/**
 * What LibGen needs and the others ignore. Passed in rather than reached for,
 * so nothing under `api/` has to know about the server's `MirrorService`.
 */
export interface SourceContext {
  candidates: MirrorCandidate[];
  adapter?: Adapter;
  onMirrorUnreachable?: (mirrorSource: string) => void;
}

export interface Source {
  id: SourceId;
  /** Shown on the row badge in the web UI. */
  label: string;
  /**
   * Whether this source can answer this kind of query at all. Sci-Hub takes a
   * DOI and nothing else; arXiv has no notion of a LibGen issue id. A source
   * that cannot answer is skipped rather than asked and failed.
   */
  handles(query: ParsedQuery): boolean;
  search(query: ParsedQuery, page: number, context: SourceContext): Promise<SourceOutcome>;
}

/**
 * Extra fetch options a download needs because of *where* it is hosted.
 *
 * Keyed on the URL rather than on the source that produced it: a Sci-Hub link
 * queued by hand needs the certificate pin just as much as one that came from
 * a search, and every other host wants nothing special. Returning `{}` is the
 * normal answer, and the pin never leaks past the hosts that require it.
 */
export const downloadRequestInit = (downloadURL: string): RequestInit => {
  if (isSciHubPageHost(downloadURL)) {
    return scihubRequestInit();
  }

  return {};
};

/** Why one source returned nothing, when the others did return something. */
export interface SourceNote {
  source: SourceId;
  message: string;
}

export interface FanOutResult {
  items: SourceResult[];
  notes: SourceNote[];
  /** How many sources were actually asked, so "all of them failed" is knowable. */
  asked: number;
}

/**
 * Asks every source that handles the query, at the same time.
 *
 * In parallel because the sources are unrelated services: run serially, arXiv's
 * mandated three-second pacing and Sci-Hub's round trip would both be added to
 * the time LibGen already takes. Run together, the search costs the slowest
 * source rather than the sum.
 *
 * A source that throws or errors contributes a note and nothing else. That is
 * the whole point of the fan-out: arXiv being down is not a reason to withhold
 * LibGen's results.
 */
export const searchSources = async (
  sources: Source[],
  query: ParsedQuery,
  page: number,
  context: SourceContext
): Promise<FanOutResult> => {
  const applicable = sources.filter((source) => source.handles(query));

  const outcomes = await Promise.all(
    applicable.map(async (source): Promise<SourceOutcome> => {
      try {
        return await source.search(query, page, context);
      } catch (error: unknown) {
        return { status: "error", message: (error as Error)?.message || "unknown error" };
      }
    })
  );

  const items: SourceResult[] = [];
  const notes: SourceNote[] = [];

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "error") {
      notes.push({ source: applicable[index].id, message: outcome.message });
      continue;
    }

    // Grouped by source in the order given, rather than interleaved by some
    // guess at relevance: two catalogues' scores are not comparable, and the
    // UI's source filter is the honest way to isolate one.
    items.push(...outcome.items);
  }

  return { items, notes, asked: applicable.length };
};
