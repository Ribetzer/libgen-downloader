/**
 * Anna's Archive's member API: a download link for a file, by MD5, from its
 * own fast servers. It holds LibGen's files under the same MD5s, so it is a
 * second way to a file LibGen's own download server keeps dropping.
 *
 * Its pages sit behind DDoS-Guard's browser check, which is not something to
 * get round; this endpoint is documented for scripts and answers them with
 * JSON. It needs a member's secret key, which lives in the server's
 * environment (ANNAS_ARCHIVE_KEY) and never in the repository. Without one,
 * none of this runs.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export const DEFAULT_ANNAS_DOMAIN = "annas-archive.gl";

export type AnnasLinkOutcome =
  | { status: "ok"; downloadURL: string; downloadsLeft?: number }
  /**
   * `exhausted`: the day's fast downloads are used up, or the account is not
   * (or no longer) a member - nothing more will work until that changes.
   */
  | { status: "error"; message: string; exhausted: boolean };

interface FastDownloadResponse {
  download_url?: string | null;
  error?: string;
  account_fast_download_info?: { downloads_left?: number } | null;
}

export const buildFastDownloadURL = (domain: string, md5: string, key: string): string => {
  const url = new URL(`https://${domain}/dyn/api/fast_download.json`);
  url.searchParams.set("md5", md5);
  url.searchParams.set("key", key);
  return url.toString();
};

/** Errors that mean the key cannot fetch anything today, as opposed to this one file. */
const EXHAUSTED =
  /invalid secret key|not a member|no (more )?downloads left|downloads_left|membership/i;

export const fetchAnnasDownloadURL = async (
  md5: string,
  key: string,
  domain = DEFAULT_ANNAS_DOMAIN,
  proxy?: string
): Promise<AnnasLinkOutcome> => {
  let response: Response;
  try {
    response = await fetch(buildFastDownloadURL(domain, md5, key), {
      proxy,
      headers: { "user-agent": "libgen-downloader (https://github.com/obsfx/libgen-downloader)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as RequestInit);
  } catch (error: unknown) {
    return {
      status: "error",
      message: `Couldn't reach Anna's Archive (${(error as Error).message})`,
      exhausted: false,
    };
  }

  let body: FastDownloadResponse;
  try {
    body = (await response.json()) as FastDownloadResponse;
  } catch {
    // DDoS-Guard's check page, or anything else that is not the API.
    return {
      status: "error",
      message: `Anna's Archive answered HTTP ${response.status} without its API`,
      exhausted: false,
    };
  }

  const downloadsLeft = body.account_fast_download_info?.downloads_left;
  if (body.download_url) {
    return { status: "ok", downloadURL: body.download_url, downloadsLeft };
  }

  const message = body.error || `HTTP ${response.status}`;
  return {
    status: "error",
    message: `Anna's Archive: ${message}`,
    exhausted: EXHAUSTED.test(message) || downloadsLeft === 0,
  };
};
