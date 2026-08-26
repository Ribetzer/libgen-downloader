import { parseHTML } from "linkedom";
import {
  ARXIV_API_URL,
  ARXIV_MIN_INTERVAL_MS,
  ARXIV_PAGE_SIZE,
  ARXIV_USER_AGENT,
} from "../../settings";
import { delay } from "../../utilities";
import type { Entry } from "../models/entry";
import type { Source, SourceResult } from "./index";

/**
 * arXiv, as a source alongside LibGen rather than a mirror of it.
 *
 * It is deliberately not an `Adapter`. That abstraction exists to hide the
 * differences between mirrors of the *same* catalogue - same HTML, same MD5s,
 * same detail pages - and every method on it assumes that shape. arXiv has no
 * MD5, no detail page to scrape, and answers Atom rather than HTML, so
 * implementing `Adapter` would mean stubbing most of it.
 *
 * What it does have is a direct PDF URL on every record, which is why the
 * download path needed a URL entry point rather than an MD5 one.
 *
 * No new parser: `linkedom` is already a dependency for LibGen's HTML, and it
 * reads this Atom fine. The one thing it will not do is namespaced lookups -
 * `querySelector("arxiv:doi")` finds nothing - so those are read by scanning
 * tag names instead.
 */

export interface ArxivRecord {
  /** `2304.00359v1` - the version is part of the identity, as on HAL. */
  id: string;
  title: string;
  authors: string[];
  published: string;
  summary: string;
  /** Straight to the file; no page to scrape on the way. */
  pdfURL: string;
  /** Set once a preprint has been published somewhere with a DOI. */
  doi: string;
}

const ABSTRACT_URL_PATTERN = /arxiv\.org\/abs\/(.+)$/i;

/** `http://arxiv.org/abs/2304.00359v1` -> `2304.00359v1`. */
export const readArxivId = (idURL: string): string => {
  const match = idURL.trim().match(ABSTRACT_URL_PATTERN);
  if (!match) {
    return "";
  }

  return match[1].trim();
};

/**
 * Atom collapses whitespace badly: arXiv wraps titles and abstracts at the
 * source, so a title arrives with newlines and runs of spaces inside it.
 */
const collapse = (value: string | null | undefined): string =>
  (value || "").replaceAll(/\s+/g, " ").trim();

/**
 * A namespaced child, by local name. `linkedom`'s `querySelector` cannot
 * express `arxiv:doi`, so the children are scanned instead - there are only a
 * handful per entry, and this avoids a parser dependency for one field.
 */
const namespacedText = (entry: Element, localName: string): string => {
  for (const child of entry.children) {
    const tag = child.tagName.toLowerCase();
    if (tag === localName || tag.endsWith(`:${localName}`)) {
      return collapse(child.textContent);
    }
  }

  return "";
};

export const parseArxivFeed = (xml: string): ArxivRecord[] => {
  const { document } = parseHTML(xml);
  const records: ArxivRecord[] = [];

  for (const entry of document.querySelectorAll("entry")) {
    const id = readArxivId(entry.querySelector("id")?.textContent || "");
    if (!id) {
      continue;
    }

    // `rel="related" type="application/pdf"`, rather than rewriting the
    // abstract URL by hand: arXiv states the location and it costs nothing to
    // believe it.
    const links = [...entry.querySelectorAll("link")];
    const pdfURL =
      links.find((link) => link.getAttribute("type") === "application/pdf")?.getAttribute("href") ||
      "";
    if (!pdfURL) {
      continue;
    }

    records.push({
      id,
      title: collapse(entry.querySelector("title")?.textContent),
      authors: [...entry.querySelectorAll("author name")].map((name) => collapse(name.textContent)),
      published: collapse(entry.querySelector("published")?.textContent),
      summary: collapse(entry.querySelector("summary")?.textContent),
      pdfURL,
      doi: namespacedText(entry, "doi"),
    });
  }

  return records;
};

export const buildArxivSearchURL = (
  query: string,
  pageNumber: number,
  pageSize: number
): string => {
  const parameters = new URLSearchParams({
    // `all:` searches title, abstract, authors and comments together, which is
    // what someone typing a phrase into a search box means. Text only: the
    // API's field prefixes are ti/au/abs/co/jr/cat/rn/id/all, so `doi:` is not
    // a search field - asking for one returns a feed with zero entries rather
    // than an error, which is why the DOI branch skips arXiv entirely.
    search_query: `all:${JSON.stringify(query.trim())}`,
    start: String(Math.max(0, pageNumber - 1) * pageSize),
    max_results: String(pageSize),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  return `${ARXIV_API_URL}?${parameters.toString()}`;
};

/** `2023-04-01T16:58:19Z` -> `2023`. Entries always carry one. */
const readYear = (published: string): string => published.slice(0, 4);

/**
 * An arXiv record in the shape the result list already renders. `mirror` is
 * the abstract page rather than the PDF, so the link a person clicks is the
 * one they would expect; the PDF travels separately as the download URL.
 */
export const toEntry = (record: ArxivRecord): Entry => ({
  id: `arxiv:${record.id}`,
  authors: record.authors.join(", "),
  title: record.title,
  publisher: "arXiv",
  year: readYear(record.published),
  pages: "",
  language: "English",
  size: "",
  extension: "pdf",
  mirror: `https://arxiv.org/abs/${record.id}`,
});

export const toResult = (record: ArxivRecord): SourceResult => ({
  ...toEntry(record),
  source: "arxiv",
  // arXiv has no MD5 anywhere in its API, and needs none: the PDF URL is the
  // record. This is the case `withIdentity` exists for.
  md5: "",
  downloadURL: record.pdfURL,
  // Already the work's own title - there is no journal line to strip.
  articleTitle: record.title,
  doi: record.doi,
});

/**
 * When the last request went out, so the next one can be spaced from it.
 * Module scope on purpose: the limit is arXiv's, per client, and a per-call
 * timer would let two concurrent searches breach it together.
 */
let lastRequestAt = 0;

/** How long a request arriving now has to wait behind the previous one. */
export const arxivWaitMs = (now: number, previousRequestAt: number): number =>
  Math.max(0, previousRequestAt + ARXIV_MIN_INTERVAL_MS - now);

/** Waits out whatever is left of arXiv's three seconds, if anything. */
const pace = async (): Promise<void> => {
  const now = Date.now();
  const waitMs = arxivWaitMs(now, lastRequestAt);
  // The slot is claimed before the wait, not after: two callers arriving
  // together must queue three seconds apart rather than both read the same
  // stale timestamp, decide nothing is due, and go out at once.
  lastRequestAt = Math.max(now, lastRequestAt + ARXIV_MIN_INTERVAL_MS);

  if (waitMs > 0) {
    await delay(waitMs);
  }
};

/** For tests, which must not sit out a real three seconds. */
export const resetArxivPacing = (): void => {
  lastRequestAt = 0;
};

export const arxivSource: Source = {
  id: "arxiv",
  label: "arXiv",
  // Text only. A DOI names a published article, and arXiv cannot be searched
  // by one; an issue id is LibGen's own concept and means nothing here.
  handles: (query) => query.kind === "text",
  async search(parsedQuery, page) {
    if (parsedQuery.kind !== "text") {
      return { status: "ok", items: [] };
    }

    await pace();

    const response = await fetch(buildArxivSearchURL(parsedQuery.query, page, ARXIV_PAGE_SIZE), {
      headers: { "user-agent": ARXIV_USER_AGENT },
    });

    if (!response.ok) {
      return { status: "error", message: `arXiv answered HTTP ${response.status}` };
    }

    return {
      status: "ok",
      items: parseArxivFeed(await response.text()).map((record) => toResult(record)),
    };
  },
};
