import { findArxivByTitle } from "./arxiv";
import { wileyServesPDF, wileyTDMEnabled, wileyTDMURL } from "./wiley-tdm";
import type { Source, SourceResult } from "./index";

/**
 * Legal, free copies of a paper, for the DOIs no library holds.
 *
 * Unpaywall lists every open-access copy it knows of - the publisher's, and
 * the ones authors deposit in HAL, university repositories and the like. The
 * publisher's is often behind a bot check (Wiley's "Just a moment…"), which
 * is not something to get round, so repository copies are tried first and a
 * copy only counts once its server has actually answered with a PDF. When no
 * copy works, the paper's title is looked for on arXiv, where many graphics
 * papers have a preprint.
 *
 * Unpaywall asks for a contact address with every request; without one this
 * source stays out of the way. It is only used here, where it was agreed to.
 */
const UNPAYWALL_URL = "https://api.unpaywall.org/v2";
const REQUEST_TIMEOUT_MS = 30_000;

const contactEmail = (): string => process.env.LIBGEN_OPEN_ACCESS_EMAIL || "";

/**
 * Says who is asking, honestly. Repositories were seen to wave this through
 * where a browser disguise from a VPN address got a bot check instead.
 */
const userAgent = (): string =>
  `libgen-downloader (https://github.com/obsfx/libgen-downloader; mailto:${contactEmail()})`;

interface UnpaywallLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  host_type?: string | null;
}

interface UnpaywallRecord {
  title?: string | null;
  year?: number | null;
  z_authors?: { given?: string; family?: string }[] | null;
  journal_name?: string | null;
  publisher?: string | null;
  oa_locations?: UnpaywallLocation[] | null;
}

/** Whether Wiley publishes it, so its TDM API may serve the PDF. */
export const isWiley = (record: UnpaywallRecord): boolean =>
  /wiley/i.test(record.publisher || "") ||
  (record.oa_locations || []).some((location) =>
    /wiley\.com/i.test(`${location.url || ""} ${location.url_for_pdf || ""}`)
  );

/** Repository copies first: publishers are where the bot checks are. */
export const orderLocations = (locations: UnpaywallLocation[]): UnpaywallLocation[] => [
  ...locations.filter((location) => location.host_type !== "publisher"),
  ...locations.filter((location) => location.host_type === "publisher"),
];

/** The PDF a landing page links, as repositories and publishers both declare it. */
export const readCitationPDF = (html: string, pageURL: string): string | undefined => {
  const match =
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i.exec(html);
  if (!match) {
    return undefined;
  }

  try {
    return new URL(match[1], pageURL).toString();
  } catch {
    return undefined;
  }
};

/**
 * HAL's own address for a record's PDF. Unpaywall's HAL links name the file,
 * and when a deposit is revised the file is renamed and the old link answers
 * with HAL's search page - seen for 10.1111/cgf.14766 - while
 * `/<record>/document` keeps serving the current PDF.
 */
export const halDocumentURL = (url: string): string | undefined => {
  const match = /^https?:\/\/([^/]*hal[^/]*)\/(hal-\d+)(?:v\d+)?(?:\/|$)/i.exec(url);
  if (!match) {
    return undefined;
  }

  return `https://${match[1]}/${match[2]}/document`;
};

const get = (url: string, accept: string) =>
  fetch(url, {
    headers: { "user-agent": userAgent(), accept },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

/**
 * The URL of a PDF this location really serves, or nothing. A PDF link is
 * checked by its answer's content type; a landing page is read for the PDF
 * it declares, which is then checked the same way. The body is not read -
 * the queue downloads it - so a check costs one request's headers.
 */
const workingPDF = async (location: UnpaywallLocation): Promise<string | undefined> => {
  const candidates: string[] = [];
  if (location.url_for_pdf) {
    candidates.push(location.url_for_pdf);
  }

  if (location.url && location.url !== location.url_for_pdf) {
    try {
      const page = await get(location.url, "text/html,application/pdf");
      if ((page.headers.get("content-type") || "").includes("pdf")) {
        await page.body?.cancel();
        return page.url || location.url;
      }

      const declared = readCitationPDF(await page.text(), page.url || location.url);
      if (declared) {
        candidates.push(declared);
      }
    } catch {
      // An unreachable landing page leaves only the direct link, if any.
    }
  }

  // Last, the stable address, in case the linked file has been renamed.
  const hal = halDocumentURL(location.url_for_pdf || location.url || "");
  if (hal && !candidates.includes(hal)) {
    candidates.push(hal);
  }

  for (const candidate of candidates) {
    try {
      const response = await get(candidate, "application/pdf");
      const isPDF = response.ok && (response.headers.get("content-type") || "").includes("pdf");
      await response.body?.cancel();
      if (isPDF) {
        return response.url || candidate;
      }
    } catch {
      // Try the next one.
    }
  }

  return undefined;
};

const toResult = (
  doi: string,
  record: UnpaywallRecord,
  downloadURL: string,
  source: SourceResult["source"]
): SourceResult => {
  const title = record.title || "";
  const authors = (record.z_authors || [])
    .map((author) => [author.given, author.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");

  return {
    id: `oa:${doi}`,
    source,
    md5: "",
    downloadURL,
    articleTitle: title,
    title,
    doi,
    authors,
    publisher: record.journal_name || "",
    year: String(record.year ?? ""),
    pages: "",
    language: "",
    size: "",
    extension: "pdf",
    mirror: downloadURL,
  };
};

export const openAccessSource: Source = {
  id: "openaccess",
  label: "Open access",
  handles: (query) => query.kind === "doi" && Boolean(contactEmail()),
  async search(parsedQuery) {
    if (parsedQuery.kind !== "doi" || !contactEmail()) {
      return { status: "ok", items: [] };
    }

    const { doi } = parsedQuery;
    let record: UnpaywallRecord;
    try {
      const response = await get(
        `${UNPAYWALL_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(contactEmail())}`,
        "application/json"
      );
      if (response.status === 404) {
        return { status: "ok", items: [] };
      }
      if (!response.ok) {
        return { status: "error", message: `Unpaywall answered HTTP ${response.status}` };
      }
      record = (await response.json()) as UnpaywallRecord;
    } catch (error: unknown) {
      return { status: "error", message: `Couldn't reach Unpaywall (${(error as Error).message})` };
    }

    for (const location of orderLocations(record.oa_locations || [])) {
      const pdf = await workingPDF(location);
      if (pdf) {
        return { status: "ok", items: [toResult(doi, record, pdf, "openaccess")] };
      }
    }

    // Wiley's own copy, through the route Wiley offers scripts - its website
    // answers them with Cloudflare's check. Only with a token, and only for
    // a paper Wiley publishes.
    if (wileyTDMEnabled() && isWiley(record) && (await wileyServesPDF(doi))) {
      return { status: "ok", items: [toResult(doi, record, wileyTDMURL(doi), "openaccess")] };
    }

    // No copy that answers with a PDF: a preprint under the same title.
    if (record.title) {
      try {
        const preprint = await findArxivByTitle(record.title);
        if (preprint) {
          return { status: "ok", items: [toResult(doi, record, preprint.pdfURL, "arxiv")] };
        }
      } catch {
        // arXiv unreachable is the same as arXiv not having it, for this.
      }
    }

    return { status: "ok", items: [] };
  },
};
