import { CORPUS_TIMEOUT_MS } from "../settings";

export interface OwnedResult {
  owned: number[];
  configured: boolean;
  error?: string;
}

interface CorpusServiceArguments {
  /** Base URL of a service that can say which papers are already held. */
  url: string;
  timeoutMs?: number;
}

/**
 * Asks a library service which search results it already holds, so the UI can
 * say so before anything is downloaded.
 *
 * Everything here degrades to "nothing known" rather than failing. An
 * annotation that a paper is already on the shelf is useful; making the search
 * wait on a second service, or fail because that service is down, is not. The
 * answer is indices into the list that was sent, so the caller does not have to
 * match records back up itself.
 */
export class CorpusService {
  private url: string;
  private timeoutMs: number;

  constructor({ url, timeoutMs = CORPUS_TIMEOUT_MS }: CorpusServiceArguments) {
    this.url = url.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  isConfigured(): boolean {
    return this.url.length > 0;
  }

  async owned(body: string): Promise<OwnedResult> {
    if (!this.isConfigured()) {
      return { owned: [], configured: false };
    }

    try {
      const response = await fetch(`${this.url}/api/owned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return { owned: [], configured: true, error: `library answered ${response.status}` };
      }

      const payload = (await response.json()) as { owned?: unknown };
      if (!Array.isArray(payload.owned)) {
        return { owned: [], configured: true, error: "library answered in an unexpected shape" };
      }

      // Indices only, and only ones that could address the list sent.
      const owned = payload.owned.filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value >= 0
      );

      return { owned, configured: true };
    } catch (error: unknown) {
      return { owned: [], configured: true, error: (error as Error).message };
    }
  }
}
