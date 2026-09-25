import { WILEY_TDM_MIN_INTERVAL_MS, WILEY_TDM_URL } from "../../settings";
import { delay } from "../../utilities";

/**
 * Wiley's text-and-data-mining API: the publisher's own route for fetching
 * an article's PDF by DOI from a script. Its website puts open-access PDFs
 * behind Cloudflare's browser check, which is not something to get round;
 * this is the route Wiley offers instead. It needs a personal token
 * (WILEY_TDM_TOKEN, from a free Wiley Online Library account, kept in .env)
 * sent as a header on every request, and it serves what the token is entitled
 * to - open-access articles, and any the account's institution subscribes to.
 */
const WILEY_HOST = "api.wiley.com";

const token = (): string => process.env.WILEY_TDM_TOKEN || "";

/**
 * A proxy that is not behind the VPN, for these requests only. Cloudflare in
 * front of api.wiley.com answers VPN exit IPs with "Attention Required!",
 * token or no token - measured on every lane - while the same request from an
 * ordinary connection gets the PDF. So Wiley, and nothing else, goes out that
 * way; it is the publisher's own API, called with the account's own token.
 */
const directProxy = (): string | undefined => process.env.LIBGEN_WILEY_PROXY || undefined;

export const wileyTDMEnabled = (): boolean => Boolean(token());

export const wileyTDMURL = (doi: string): string => `${WILEY_TDM_URL}${encodeURIComponent(doi)}`;

/** The token header for a request to the TDM API; nothing for anywhere else. */
export const wileyRequestInit = (url: string): RequestInit | undefined => {
  try {
    if (new URL(url).hostname !== WILEY_HOST || !token()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    headers: { "Wiley-TDM-Client-Token": token() },
    proxy: directProxy(),
  } as RequestInit;
};

/**
 * Spacing for every TDM request, at module scope because the limit is the
 * token's: 60 per 10 minutes, under Wiley's terms.
 */
let lastRequestAt = 0;

export const paceWiley = async (): Promise<void> => {
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + WILEY_TDM_MIN_INTERVAL_MS - now);
  lastRequestAt = Math.max(now, lastRequestAt + WILEY_TDM_MIN_INTERVAL_MS);
  if (waitMs > 0) {
    await delay(waitMs);
  }
};

/** For tests. */
export const resetWileyPacing = (): void => {
  lastRequestAt = 0;
};

/**
 * Whether the token can fetch this DOI's PDF, checked by asking for it and
 * reading only the answer's headers. The download itself follows through
 * the queue, with the token added by `downloadRequestInit`.
 */
export const wileyServesPDF = async (doi: string): Promise<boolean> => {
  const init = wileyRequestInit(wileyTDMURL(doi));
  if (!init) {
    return false;
  }

  await paceWiley();
  try {
    const response = await fetch(wileyTDMURL(doi), {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    const isPDF = response.ok && (response.headers.get("content-type") || "").includes("pdf");
    await response.body?.cancel();
    if (isPDF) {
      // The download that follows is a second request against the limit.
      await paceWiley();
    }
    return isPDF;
  } catch {
    return false;
  }
};
