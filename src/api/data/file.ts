import fs from "node:fs";
import { extractMD5 } from "./md5";

const MIRROR_HEADER_PREFIX = "# mirror:";
const BYTE_ORDER_MARK = String.fromCodePoint(0xfe_ff);

export interface InvalidMD5Line {
  lineNumber: number;
  content: string;
}

export interface MD5ListParseResult {
  md5List: string[];
  invalidLines: InvalidMD5Line[];
  preferredMirror: string | undefined;
}

/**
 * Parses an MD5 list file. Tolerates CRLF endings, a UTF-8 BOM, blank lines,
 * `#` comments, duplicates and full detail page URLs, and reports the lines it
 * could not understand instead of turning them into doomed requests.
 */
export function parseMD5List(contents: string): MD5ListParseResult {
  const md5List: string[] = [];
  const invalidLines: InvalidMD5Line[] = [];
  const seenMD5s = new Set<string>();
  let preferredMirror: string | undefined;

  let normalizedContents = contents;
  if (normalizedContents.startsWith(BYTE_ORDER_MARK)) {
    normalizedContents = normalizedContents.slice(BYTE_ORDER_MARK.length);
  }

  const lines = normalizedContents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      continue;
    }

    if (trimmedLine.startsWith("#")) {
      if (!preferredMirror && trimmedLine.toLowerCase().startsWith(MIRROR_HEADER_PREFIX)) {
        preferredMirror = trimmedLine.slice(MIRROR_HEADER_PREFIX.length).trim() || undefined;
      }
      continue;
    }

    const md5 = extractMD5(trimmedLine);
    if (!md5) {
      invalidLines.push({ lineNumber: index + 1, content: trimmedLine });
      continue;
    }

    if (seenMD5s.has(md5)) {
      continue;
    }

    seenMD5s.add(md5);
    md5List.push(md5);
  }

  return { md5List, invalidLines, preferredMirror };
}

export async function createMD5ListFile(md5List: string[], mirrorSource?: string) {
  const filename = `libgen_downloader_md5_list_${Date.now().toString()}.txt`;

  const lines: string[] = [];
  if (mirrorSource) {
    lines.push(`${MIRROR_HEADER_PREFIX} ${mirrorSource}`);
  }
  lines.push(...md5List);

  await fs.promises.writeFile(`./${filename}`, lines.join("\n"));
  return filename;
}
