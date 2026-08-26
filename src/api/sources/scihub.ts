import { parseHTML } from "linkedom";
import { SCIHUB_HOSTS } from "../../settings";
import type { Source, SourceResult } from "./index";

/**
 * Sci-Hub, by DOI. There is no search: a DOI names one article and the site
 * either has it or does not.
 *
 * ## Why the TLS handling is what it is
 *
 * Sci-Hub's page hosts sit behind DDoS-Guard, which serves a **self-signed**
 * certificate with no CN and no subjectAltName - `C=EU, ST=*, O=ddos-guard`.
 * An ordinary fetch is rejected with `self signed certificate`, and that is
 * correct behaviour: nothing in the public trust store vouches for it.
 *
 * Rather than disable verification, that one certificate is supplied as the
 * only trust anchor for these requests. `checkServerIdentity` is waived
 * alongside it because the certificate names no host and so can never satisfy
 * a hostname check - without the waiver the connection fails
 * `ERR_TLS_CERT_ALTNAME_INVALID`. Both are needed and each was measured:
 *
 *     plain fetch      rejected: self signed certificate
 *     ca only          rejected: ERR_TLS_CERT_ALTNAME_INVALID
 *     identity only    rejected: self signed certificate
 *     ca + identity    200
 *     *wrong* ca       rejected: self signed certificate
 *
 * The last line is the one that matters: substituting a different certificate
 * fails, so this is a pin and not a bypass. Verification stays on everywhere
 * else - `NODE_TLS_REJECT_UNAUTHORIZED` would have switched it off for LibGen
 * and arXiv too, which is why it is not used.
 *
 * The certificate is stable: identical across repeated connections and across
 * both hosts, valid 2018-03-28 to 2028-03-25. When it rotates, this constant
 * has to be replaced and every Sci-Hub request will fail loudly until it is.
 *
 * ## The file itself needs none of this
 *
 * The PDF lives on a *storage* host with an ordinary Let's Encrypt
 * certificate, so the download goes over the normal verified path with no
 * special casing at all. The pin covers the DOI lookup page and nothing else.
 */

const SCIHUB_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIC2DCCAcACCQD6cDrf+5h8CTANBgkqhkiG9w0BAQsFADAuMQswCQYDVQQGEwJF
VTEKMAgGA1UECAwBKjETMBEGA1UECgwKZGRvcy1ndWFyZDAeFw0xODAzMjgxOTI2
MTNaFw0yODAzMjUxOTI2MTNaMC4xCzAJBgNVBAYTAkVVMQowCAYDVQQIDAEqMRMw
EQYDVQQKDApkZG9zLWd1YXJkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAzKzaWH/6SlOzAEg9angONqEF1Oj6XUY0bD7r0RLD4LFCJz+ijj8tvYMrnAud
RV29cPsd81XvdC+ig7TQG6GMwpNMGf6LkBWpIyhzxpJBi5bkrF9XcgivOhR4vn2T
PDjtKdL8gnivv1NOcJCPlCkgBHTWQjWmtz2mVT4F63kWySGYLqp6I7W/9Rx8eMDM
L+o7zFnP0kh6ywOJa4yHWQPwWMvfdXy9uY4EL6Q0Tx3Mh5wGTZ9Q1cQLiGznsKau
bY9rzH6u2ib/ZN3ZgtH8JtzD8A8V0s6e3cQlzLvNUrMc7yLPnpc738ZgEM2EkL3a
ZyGo8CkpAwcH6JOUJKmrOQ7TewIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAxdiUM
btMJxd5fd9nXNAVy6F032z4xhAeDoNe5wVGHEJ8uqxiX3TVsSPJJnAJGWi/5E79S
44TP+gst/MwwXZXB4CsRwy3QqB5s1NmedFM9BOBue2YPEuFc20RwHj2i6S4+doHJ
eLuQK3wHiO+/5eUu9KB5OVrY9BT8cBmxj6pzFwiJWgNRXfLzr4SUm6fQMqm13cyC
CzRahrGQFdPU2TkRlrXgmQwhoOavHnvBogrzD4U8j0I8yOebSGprpKehwGhzTozg
19/Imahru19aOD42v2C75tWIU/WSzOjFw3za5TxywfaBDLszAmjoTflAid/RM1SD
AzuxI494CzdwGm1p
-----END CERTIFICATE-----
`;

/** For the pin test, and so a rotation can be recognised rather than guessed at. */
export const SCIHUB_CERTIFICATE_FINGERPRINT =
  "C0:E5:E3:74:C1:07:DF:95:3A:89:FF:E2:31:89:E5:2B:E7:EB:AF:1D:F0:FC:1F:97:13:E6:8D:7B:4E:EF:86:E4";

/**
 * The pinned request options. Scoped to one call rather than set anywhere
 * global, which is the entire point.
 */
export const scihubRequestInit = (): RequestInit =>
  ({
    tls: {
      ca: SCIHUB_CERTIFICATE,
      // The certificate names no host, so there is nothing for the default
      // check to compare against. `ca` above is what actually constrains this.
      // Returning nothing is how this hook says "no objection"; the lint rule
      // reads that as a useless undefined, which here it is not.
      // eslint-disable-next-line unicorn/no-useless-undefined
      checkServerIdentity: () => undefined,
    },
  }) as RequestInit;

/**
 * Whether a URL points at a Sci-Hub *page* host, and so needs the pin.
 *
 * The PDF link comes in two spellings and they differ in exactly this way:
 * `//sci-hub.red/storage/…` is a separate storage host with an ordinary Let's
 * Encrypt certificate, while `/storage/…` resolves against the page host and
 * is served through DDoS-Guard behind the self-signed one. Both were seen on
 * the same day for different DOIs, so the download cannot assume either.
 *
 * Matching on the host rather than on which source queued the row means a URL
 * pasted in by hand gets the same treatment.
 */
export const isSciHubPageHost = (downloadURL: string): boolean => {
  try {
    return getSciHubHosts().includes(new URL(downloadURL).hostname);
  } catch {
    return false;
  }
};

/** The hosts to try, overridable so a dead one needs no code change. */
export const getSciHubHosts = (): string[] => {
  const configured = (process.env.LIBGEN_SCIHUB_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return SCIHUB_HOSTS;
};

export type SciHubPage =
  | { status: "found"; pdfURL: string; title: string; journal: string; year: string }
  | { status: "not_found" }
  /** Rate limited: an Altcha proof-of-work page. Not an answer about the DOI. */
  | { status: "challenged" };

/**
 * Sci-Hub answers a DOI three distinguishable ways, all observed directly:
 *
 *   200 ~26 KB  "Sci-Hub. <title> / <journal>, <year>"  - has it
 *   404 ~4.7 KB "Keine Artikel für Ihre Anfrage gefunden" - does not have it
 *   200 ~7.3 KB "Sind Sie ein Roboter?"                  - asking for a captcha
 *
 * Telling the third apart from the second is the point of this function. A
 * captcha reported as "not found" would be a lie that sends the caller looking
 * elsewhere for a paper Sci-Hub is holding.
 */
export const readSciHubPage = (html: string, status: number, host: string): SciHubPage => {
  if (status === 404) {
    return { status: "not_found" };
  }

  const { document } = parseHTML(html);
  const pdfURL =
    document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content") || "";

  if (!pdfURL) {
    return { status: "challenged" };
  }

  const meta = (name: string) =>
    document.querySelector(`meta[name="citation_${name}"]`)?.getAttribute("content") || "";

  return {
    status: "found",
    pdfURL: absolutePDFURL(pdfURL, host),
    title: meta("title"),
    journal: meta("journal_title"),
    year: meta("publication_date").slice(0, 4),
  };
};

/**
 * The PDF sits on a storage host that is usually *not* the page host, and the
 * link comes in both spellings: `//sci-hub.red/storage/…` (protocol-relative,
 * a different host) and `/storage/…` (this host). Both were observed on the
 * same day, so both are handled.
 */
export const absolutePDFURL = (raw: string, host: string): string => {
  const value = raw.trim();

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return new URL(value, `https://${host}`).toString();
};

const buildResult = (doi: string, host: string, page: SciHubPage & { status: "found" }) => {
  const title = page.title || doi;

  const result: SourceResult = {
    id: `scihub:${doi}`,
    authors: "",
    title,
    publisher: page.journal || "Sci-Hub",
    year: page.year,
    pages: "",
    language: "",
    size: "",
    extension: "pdf",
    // The lookup page, so the link a person clicks is the record they searched.
    mirror: `https://${host}/${doi}`,
    source: "scihub",
    md5: "",
    downloadURL: page.pdfURL,
    articleTitle: title,
    // Found *by* DOI, so this one is never a guess - which is what lets the
    // downloaded filename carry it and the RAG identify the file from the name.
    doi,
  };

  return result;
};

export const scihubSource: Source = {
  id: "scihub",
  label: "Sci-Hub",
  // A DOI and nothing else. There is no text index to search.
  handles: (query) => query.kind === "doi",
  async search(parsedQuery) {
    if (parsedQuery.kind !== "doi") {
      return { status: "ok", items: [] };
    }

    const hosts = getSciHubHosts();
    const failures: string[] = [];
    let challenged = false;

    for (const host of hosts) {
      let response: Response;
      try {
        // One request per host per search. The captcha is rate-triggered, so
        // hammering it is what causes the thing being worked around.
        response = await fetch(`https://${host}/${parsedQuery.doi}`, scihubRequestInit());
      } catch (error: unknown) {
        failures.push(`${host}: ${(error as Error)?.message || "unreachable"}`);
        continue;
      }

      const page = readSciHubPage(await response.text(), response.status, host);

      if (page.status === "found") {
        return { status: "ok", items: [buildResult(parsedQuery.doi, host, page)] };
      }

      if (page.status === "challenged") {
        challenged = true;
        continue;
      }

      // Every host serves the same library, so one saying "no such article" is
      // the answer for all of them. No point asking the rest.
      return { status: "ok", items: [] };
    }

    if (challenged) {
      return { status: "error", message: "Sci-Hub asked for a captcha; try again in a minute" };
    }

    return { status: "error", message: `Couldn't reach Sci-Hub (${failures.join(", ")})` };
  },
};
