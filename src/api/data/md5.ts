export const MD5_PATTERN = /[\da-f]{32}/i;

/**
 * Pulls a canonical MD5 out of arbitrary text. Accepts a bare hash, a hash
 * surrounded by punctuation, or a full detail page URL. Anything without a
 * 32 character hex run is rejected, which is what keeps CRLF endings, BOMs
 * and stray separators out of the request query.
 */
export function extractMD5(text: string): string | undefined {
  const match = text.match(MD5_PATTERN);
  if (!match) {
    return undefined;
  }

  return match[0].toLowerCase();
}

/**
 * Reads the MD5 of a detail page URL produced by an adapter. The `md5` query
 * parameter is authoritative when present, so mirrors that key their records
 * on something other than a 32 character hash keep working.
 */
export function getMD5FromURL(url: string): string | undefined {
  try {
    const parameter = new URL(url).searchParams.get("md5")?.trim();
    if (parameter) {
      return parameter.toLowerCase();
    }
  } catch {
    // Not an absolute URL, fall through to pattern matching.
  }

  return extractMD5(url);
}
