/**
 * What a DOI *is* - title, authors, year, venue - looked up independently of
 * whether any library holds a file for it. A list of bare DOIs is otherwise
 * unreadable until each one has downloaded, and one that never does would stay
 * a string of digits forever.
 *
 * Crossref first, because its list endpoint answers many DOIs in one request.
 * doi.org's content negotiation second, for what Crossref does not hold:
 * DataCite registers Zenodo and Eurographics, and doi.org answers for every
 * registration agency. OpenAlex is deliberately not used - without an API key
 * it draws on a daily budget shared by everyone behind the same IP, which a VPN
 * exit exhausts long before midnight.
 */

export interface DOIMetadata {
  /** `missing` means every source answered and none had the DOI. */
  status: "found" | "missing";
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  source?: "crossref" | "doi.org";
}

const CROSSREF_WORKS_URL = "https://api.crossref.org/works";
const CSL_MEDIA_TYPE = "application/vnd.citationstyles.csl+json";

/**
 * Crossref titles carry JATS markup: `Will GPT-4 Run <i>DOOM</i>?`. Some come
 * pretty-printed, a line break and indent around every tag -
 * `C⏎    <scp>onsistent</scp>⏎    Z⏎    <scp>oom</scp>` for "ConsistentZoomOut" -
 * so whitespace that breaks a line beside a tag is layout, not a space in the
 * title, and collapsing it to one space read as "C onsistent Z oom O ut".
 */
export const stripMarkup = (value: string): string =>
  value
    .replaceAll(/\s*\n\s*(<[^>]+>)/g, "$1")
    .replaceAll(/(<[^>]+>)\s*\n\s*/g, "$1")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();

/** Crossref gives lists where CSL from DataCite often gives plain strings. */
const firstText = (value: unknown): string => {
  if (Array.isArray(value)) {
    return firstText(value[0]);
  }

  if (typeof value === "string") {
    return stripMarkup(value);
  }

  return "";
};

interface NamePart {
  given?: string;
  family?: string;
  name?: string;
  literal?: string;
}

const authorNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as NamePart[])
    .map((author) => {
      const parts = [author.given, author.family].filter(Boolean).join(" ").trim();
      // Consortium authors carry `name` (Crossref) or `literal` (CSL) instead.
      return parts || (author.name || author.literal || "").trim();
    })
    .filter(Boolean);
};

const issuedYear = (value: unknown): number | undefined => {
  const year = (value as { "date-parts"?: unknown[][] } | undefined)?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number") {
    return year;
  }

  return undefined;
};

/** One work record, in either Crossref's or CSL's shape - they share most keys. */
const toMetadata = (
  record: Record<string, unknown>,
  source: DOIMetadata["source"]
): DOIMetadata | undefined => {
  const title = firstText(record.title);
  if (!title) {
    return undefined;
  }

  return {
    status: "found",
    title,
    authors: authorNames(record.author),
    year: issuedYear(record.issued),
    venue: firstText(record["container-title"]) || firstText(record.publisher),
    source,
  };
};

/**
 * DOIs Crossref's filter can carry. A comma separates filters, so a DOI
 * containing one cannot be expressed there and is left to doi.org.
 */
export const isBatchableDOI = (doi: string): boolean => !doi.includes(",");

export const buildCrossrefBatchURL = (dois: string[]): string => {
  const url = new URL(CROSSREF_WORKS_URL);
  url.searchParams.set("filter", dois.map((doi) => `doi:${doi}`).join(","));
  url.searchParams.set("rows", String(Math.max(dois.length, 1)));
  url.searchParams.set("select", "DOI,title,author,issued,container-title,publisher");
  return url.toString();
};

/** Crossref's answer to a batch, keyed by lower-cased DOI. */
export const parseCrossrefWorks = (body: unknown): Map<string, DOIMetadata> => {
  const found = new Map<string, DOIMetadata>();
  const items = (body as { message?: { items?: unknown } } | undefined)?.message?.items;
  if (!Array.isArray(items)) {
    return found;
  }

  for (const item of items as Record<string, unknown>[]) {
    const metadata = toMetadata(item, "crossref");
    if (typeof item.DOI === "string" && item.DOI && metadata) {
      found.set(item.DOI.toLowerCase(), metadata);
    }
  }

  return found;
};

export const parseCSL = (body: unknown): DOIMetadata | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  return toMetadata(body as Record<string, unknown>, "doi.org");
};

/**
 * Crossref's records for up to a batch of DOIs, keyed by lower-cased DOI.
 * A DOI absent from the map is one Crossref does not hold. `undefined` means
 * the request itself failed, and says nothing about any DOI.
 */
export const fetchCrossrefBatch = async (
  dois: string[],
  userAgent: string
): Promise<Map<string, DOIMetadata> | undefined> => {
  if (dois.length === 0) {
    return new Map();
  }

  try {
    const response = await fetch(buildCrossrefBatchURL(dois), {
      headers: { "user-agent": userAgent },
    });
    if (!response.ok) {
      return undefined;
    }

    return parseCrossrefWorks(await response.json());
  } catch {
    return undefined;
  }
};

/**
 * One DOI from doi.org. `missing` when doi.org does not know the DOI - its 404
 * is authoritative across every registration agency. `undefined` when the
 * request failed and the DOI should be asked about again later.
 */
export const fetchCSL = async (
  doi: string,
  userAgent: string
): Promise<DOIMetadata | undefined> => {
  try {
    const response = await fetch(`https://doi.org/${doi}`, {
      headers: { accept: CSL_MEDIA_TYPE, "user-agent": userAgent },
    });

    if (response.status === 404) {
      return { status: "missing" };
    }

    if (!response.ok) {
      return undefined;
    }

    // A registered DOI with no metadata to negotiate answers with HTML.
    if (!(response.headers.get("content-type") || "").includes("json")) {
      return { status: "missing" };
    }

    return parseCSL(await response.json()) || { status: "missing" };
  } catch {
    return undefined;
  }
};
