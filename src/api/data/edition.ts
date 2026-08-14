import { extractMD5 } from "./md5";

/**
 * A bibliographic record from LibGen's JSON API (`json.php?object=e`), reduced
 * to what the downloader needs. The API keys its response by edition id and
 * nests a `files` object keyed by an internal id, so both levels are unwrapped
 * here.
 */
export interface EditionFile {
  fileId: string;
  md5: string;
}

export interface EditionRecord {
  editionId: string;
  title: string;
  author: string;
  year: string;
  doi: string;
  issueVolume: string;
  issueNumber: string;
  pages: string;
  files: EditionFile[];
}

export interface FileDetails {
  md5: string;
  extension: string;
  filesize: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const readString = (source: Record<string, unknown>, key: string): string => {
  const value = source[key];
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
};

const readFiles = (edition: Record<string, unknown>): EditionFile[] => {
  const files = edition.files;
  if (!isRecord(files)) {
    return [];
  }

  const editionFiles: EditionFile[] = [];
  for (const file of Object.values(files)) {
    if (!isRecord(file)) {
      continue;
    }

    const md5 = extractMD5(readString(file, "md5"));
    if (md5 && !editionFiles.some((existing) => existing.md5 === md5)) {
      editionFiles.push({ fileId: readString(file, "f_id"), md5 });
    }
  }

  return editionFiles;
};

const readPages = (edition: Record<string, unknown>): string => {
  const firstPage = readString(edition, "issue_first_page");
  const lastPage = readString(edition, "issue_last_page");

  if (firstPage && lastPage) {
    return `${firstPage}-${lastPage}`;
  }

  return firstPage || readString(edition, "pages");
};

/**
 * Tolerant by design: a lookup that matches nothing comes back as `[]`, and a
 * malformed request as `{"error": "..."}`, neither of which should throw.
 */
export const parseEditionsJSON = (payload: unknown): EditionRecord[] => {
  if (!isRecord(payload)) {
    return [];
  }

  const records: EditionRecord[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (key === "error" || !isRecord(value)) {
      continue;
    }

    records.push({
      editionId: readString(value, "e_id") || key,
      title: readString(value, "title"),
      author: readString(value, "author"),
      year: readString(value, "year"),
      doi: readString(value, "doi"),
      issueVolume: readString(value, "issue_volume"),
      issueNumber: readString(value, "issue_number"),
      pages: readPages(value),
      files: readFiles(value),
    });
  }

  return records;
};

/**
 * `json.php?object=f&ids=...` answers keyed by file id; the downloader only
 * needs to look these up by MD5.
 */
export const parseFileDetailsJSON = (payload: unknown): Map<string, FileDetails> => {
  const details = new Map<string, FileDetails>();

  if (!isRecord(payload)) {
    return details;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === "error" || !isRecord(value)) {
      continue;
    }

    const md5 = extractMD5(readString(value, "md5"));
    if (!md5) {
      continue;
    }

    details.set(md5, {
      md5,
      extension: readString(value, "extension"),
      filesize: Number(readString(value, "filesize")) || 0,
    });
  }

  return details;
};

export const getEditionMD5s = (records: EditionRecord[]): string[] => {
  const md5s: string[] = [];

  for (const record of records) {
    for (const file of record.files) {
      if (!md5s.includes(file.md5)) {
        md5s.push(file.md5);
      }
    }
  }

  return md5s;
};

export const getEditionFileIds = (records: EditionRecord[]): string[] => {
  const fileIds: string[] = [];

  for (const record of records) {
    for (const file of record.files) {
      if (file.fileId && !fileIds.includes(file.fileId)) {
        fileIds.push(file.fileId);
      }
    }
  }

  return fileIds;
};

/**
 * `https://doi.org/10.1080/X`, `doi:10.1080/X` and a bare DOI all reduce to the
 * same thing. Lookups are case-insensitive on LibGen's side, so the case the
 * user typed is preserved.
 */
export const normalizeDOI = (value: string): string | undefined => {
  const trimmed = value.trim().replace(/^doi:\s*/i, "");

  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    candidate = decodeURIComponent(url.pathname).replace(/^\//, "");
  } catch {
    // Not a URL, use the value as typed.
  }

  if (!/^10\.\d{4,9}\/\S+$/.test(candidate)) {
    return;
  }

  return candidate;
};
