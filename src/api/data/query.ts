import { normalizeDOI } from "./edition";

export type ParsedQuery =
  | { kind: "doi"; doi: string }
  | { kind: "issue"; issuesId: string; volume?: string }
  | { kind: "text"; query: string };

const ISSUES_ID_PATTERN = /issuesid:\s*(\d+)/i;
const ISSUE_VOLUME_PATTERN = /issuevolume:\s*(\S+)/i;

/**
 * Lets one input box take a plain search, a pasted DOI, or LibGen's own
 * `issuesid:… issuevolume:…` syntax, so a whole issue can be pulled without
 * assembling an MD5 list by hand.
 */
export const parseQuery = (raw: string): ParsedQuery => {
  const trimmed = raw.trim();

  const doi = normalizeDOI(trimmed);
  if (doi) {
    return { kind: "doi", doi };
  }

  const issuesId = trimmed.match(ISSUES_ID_PATTERN)?.[1];
  if (issuesId) {
    return {
      kind: "issue",
      issuesId,
      volume: trimmed.match(ISSUE_VOLUME_PATTERN)?.[1],
    };
  }

  return { kind: "text", query: trimmed };
};
