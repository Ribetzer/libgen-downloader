import { normalizeDOI } from "./edition";

/**
 * Reads the DOIs out of a BibTeX export, so a publisher's volume export or a
 * reference manager's library can be dropped on the queue like a DOI list.
 *
 * Measured on the 22 exports in the corpus inbox (2026-10-03): 292 entries,
 * every one carrying a DOI but two NVIDIA technical reports. The exporters
 * disagree on nearly everything else - `doi` or `DOI`, a bare DOI or a
 * doi.org link (ScienceDirect), `{{double braces}}` (HAL), bare values such as
 * `year = 2008`, no newline at the end - so this reads the format rather than
 * matching lines. Only DOIs are queued; an entry without one is reported by
 * its key and title, so the person can see what was left out.
 */

export interface BibTeXNoDOI {
  key: string;
  title: string;
}

export interface BibTeXParseResult {
  entryCount: number;
  doiList: string[];
  noDOI: BibTeXNoDOI[];
}

const BYTE_ORDER_MARK = "﻿";
// Entry types that hold no reference: macros, comments and LaTeX preambles.
const NON_ENTRIES = new Set(["string", "comment", "preamble"]);
const ENTRY_START = /@\s*([a-z]+)\s*([({])/giu;
const DOI_LINK = /(?:https?:\/\/)?(?:dx\.)?doi\.org\/10\.\d{4,9}\/[^\s"'<>{}]+/iu;

/** True when the first line that is not blank or a `%` comment opens an entry. */
export const looksLikeBibTeX = (contents: string): boolean => {
  for (const line of contents.replace(BYTE_ORDER_MARK, "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("%")) {
      continue;
    }
    return /^@\s*[a-z]+\s*[({]/iu.test(trimmed);
  }
  return false;
};

/** Index just past the `close` that balances the opening at `start`. */
const skipBalanced = (text: string, start: number, close: string): number => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      if (depth === 0 && close === "}") {
        return index + 1;
      }
      depth -= 1;
    } else if (character === close && depth === 0) {
      return index + 1;
    }
  }
  return text.length;
};

/** One value: `{…}`, `"…"` or a bare word, joined by `#` when concatenated. */
const readValue = (body: string, start: number): { value: string; end: number } => {
  let index = start;
  const parts: string[] = [];
  while (index < body.length) {
    while (/\s/u.test(body[index] ?? "")) {
      index += 1;
    }
    const opening = body[index];
    if (opening === "{") {
      const end = skipBalanced(body, index + 1, "}");
      parts.push(body.slice(index + 1, end - 1));
      index = end;
    } else if (opening === '"') {
      let end = index + 1;
      let depth = 0;
      while (end < body.length && !(body[end] === '"' && depth === 0)) {
        if (body[end] === "{") {
          depth += 1;
        } else if (body[end] === "}") {
          depth -= 1;
        }
        end += 1;
      }
      parts.push(body.slice(index + 1, end));
      index = end + 1;
    } else {
      const match = /^[^,#}\s]+/u.exec(body.slice(index));
      const word = match?.[0] ?? "";
      parts.push(word);
      index += Math.max(word.length, 1);
    }
    while (/\s/u.test(body[index] ?? "")) {
      index += 1;
    }
    if (body[index] !== "#") {
      break;
    }
    index += 1;
  }
  return { value: parts.join(""), end: index };
};

/** Field names in lower case, values with braces and common escapes removed. */
const readFields = (body: string): { key: string; fields: Map<string, string> } => {
  const fields = new Map<string, string>();
  const comma = body.indexOf(",");
  if (comma === -1) {
    return { key: body.trim(), fields };
  }
  const key = body.slice(0, comma).trim();
  let index = comma + 1;
  while (index < body.length) {
    const name = /^[\s,]*([\w.:-]+)\s*=/u.exec(body.slice(index));
    if (!name) {
      break;
    }
    const { value, end } = readValue(body, index + name[0].length);
    fields.set(name[1].toLowerCase(), clean(value));
    index = end;
  }
  return { key, fields };
};

const clean = (value: string): string =>
  value
    .replaceAll(/\\([_&%$#])/gu, "$1")
    .replaceAll(/[{}]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

const doiOf = (fields: Map<string, string>): string | undefined => {
  const direct = normalizeDOI(fields.get("doi") ?? "");
  if (direct) {
    return direct;
  }
  for (const name of ["url", "note", "howpublished"]) {
    const link = DOI_LINK.exec(fields.get(name) ?? "");
    const found = link && normalizeDOI(link[0].replace(/[.,;)\]]+$/u, ""));
    if (found) {
      return found;
    }
  }
  return undefined;
};

export function parseBibTeX(contents: string): BibTeXParseResult {
  const text = contents.replace(BYTE_ORDER_MARK, "");
  const doiList: string[] = [];
  const noDOI: BibTeXNoDOI[] = [];
  const seen = new Set<string>();
  let entryCount = 0;

  ENTRY_START.lastIndex = 0;
  let match = ENTRY_START.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    let close = "}";
    if (match[2] === "(") {
      close = ")";
    }
    const end = skipBalanced(text, bodyStart, close);
    ENTRY_START.lastIndex = end;

    if (!NON_ENTRIES.has(match[1].toLowerCase())) {
      entryCount += 1;
      const { key, fields } = readFields(text.slice(bodyStart, end - 1));
      const doi = doiOf(fields);
      if (!doi) {
        noDOI.push({ key, title: fields.get("title") ?? "" });
      } else if (!seen.has(doi.toLowerCase())) {
        seen.add(doi.toLowerCase());
        doiList.push(doi);
      }
    }
    match = ENTRY_START.exec(text);
  }

  return { entryCount, doiList, noDOI };
}
