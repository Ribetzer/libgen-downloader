import { parseHTML } from "linkedom";
import { BROWSER_USER_AGENT } from "../../settings";

export interface DocumentResult {
  document: Document;
  htmlString: string;
}

/**
 * Headers LibGen wants before it will serve a page.
 *
 * `ads.php` answers a bare request with 200 and an empty body, so the failure
 * is silent: the parse succeeds, the selector finds nothing, and the mirror
 * looks like it simply has no record. Both headers are required - sending
 * either one alone still gets a refusal - and the Referer only has to share the
 * host, so the mirror's own origin serves for every page on it.
 */
const requestHeaders = (url: string): Record<string, string> => {
  const referer = (() => {
    try {
      return new URL(url).origin + "/";
    } catch {
      return "";
    }
  })();

  const headers: Record<string, string> = { "user-agent": BROWSER_USER_AGENT };
  if (referer) {
    headers.referer = referer;
  }
  return headers;
};

export async function getJSON(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { headers: requestHeaders(url) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error: unknown) {
    throw new Error(`Error occured while fetching ${url}: ${(error as Error)?.message}`, {
      cause: error,
    });
  }
}

export async function getDocument(searchURL: string): Promise<DocumentResult> {
  try {
    const response = await fetch(searchURL, { headers: requestHeaders(searchURL) });
    const htmlString = await response.text();
    const { document } = parseHTML(htmlString);
    return { document: document as unknown as Document, htmlString };
  } catch {
    throw new Error(`Error occured while fetching document of ${searchURL}`);
  }
}
