const UTF8_LEAD_BYTE_START = 0xc2;
const UTF8_LEAD_BYTE_END = 0xf4;
const UTF8_CONTINUATION_START = 0x80;
const UTF8_CONTINUATION_END = 0xbf;
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xff_fd);
const FIRST_PRINTABLE_CODE_POINT = 0x20;

// A UTF-8 name read through a header decoded as ISO-8859-1 shows up as a lead
// character in the C2..F4 range followed by a continuation character, which is
// how "Möller" turns into "MÃ¶ller". Built from code points so this file stays
// ASCII and the invisible C1 characters never reach the source.
const MOJIBAKE_PATTERN = new RegExp(
  `[${String.fromCodePoint(UTF8_LEAD_BYTE_START)}-${String.fromCodePoint(UTF8_LEAD_BYTE_END)}]` +
    `[${String.fromCodePoint(UTF8_CONTINUATION_START)}-${String.fromCodePoint(UTF8_CONTINUATION_END)}]`
);

const EXTENSION_PATTERN = /\.([\dA-Za-z]{1,8})$/;
const MIRROR_SUFFIX_PATTERN = /\s+libgen\.\w+$/i;
// Journal articles arrive as "[Journal name 2013-jan vol. 17 iss. 1-2] Title…".
// The leading \s* matters: some names arrive with a leading space, and without
// it the anchor fails and the whole prefix is kept as the title.
const SERIES_PREFIX_PATTERN = /^\s*\[[^\]]*]\s*/;
const METADATA_START_PATTERN = /[([{]/;
const YEAR_PATTERN = /\((\d{4})[^)]*\)/;
const DOI_PATTERN = /\[(10\.[^\]]+)]/;
const TRAILING_DOTS_AND_SPACES_PATTERN = /[\s.]+$/;
const WINDOWS_RESERVED_PATTERN = /^(?:aux|com\d|con|lpt\d|nul|prn)$/i;

const ILLEGAL_CHARACTERS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

export const MAX_FILE_NAME_LENGTH = 150;
const MIN_TITLE_LENGTH = 16;

/**
 * Undoes the ISO-8859-1 reading of a UTF-8 filename. A value whose bytes are
 * not valid UTF-8 is returned untouched, so a name that genuinely contains
 * these characters is never corrupted.
 */
export const repairEncoding = (value: string): string => {
  if (!MOJIBAKE_PATTERN.test(value)) {
    return value;
  }

  const recovered = Buffer.from(value, "latin1").toString("utf8");
  if (recovered.includes(REPLACEMENT_CHARACTER)) {
    return value;
  }

  return recovered;
};

const splitExtension = (value: string) => {
  const match = value.match(EXTENSION_PATTERN);
  if (!match) {
    return { stem: value, extension: "" };
  }

  return { stem: value.slice(0, -match[0].length), extension: match[1] };
};

/**
 * LibGen names files `TITLE{authors}(date)[doi]{id} libgen.li.ext`. Keeping the
 * title, the year and the DOI leaves a name that reads well and still traces
 * back to the record.
 */
const readMetadata = (stem: string) => {
  const withoutMirror = stem.replace(MIRROR_SUFFIX_PATTERN, "");

  const year = withoutMirror.match(YEAR_PATTERN)?.[1];
  const doi = withoutMirror.match(DOI_PATTERN)?.[1];

  // The series prefix would otherwise be mistaken for the title and eat the
  // length budget, truncating the title that was actually wanted.
  const withoutSeries = withoutMirror.replace(SERIES_PREFIX_PATTERN, "");

  let title = withoutSeries;
  const metadataStart = withoutSeries.search(METADATA_START_PATTERN);
  if (metadataStart > 0) {
    title = withoutSeries.slice(0, metadataStart);
  }
  title = title.trim();

  if (title.length === 0) {
    title = withoutMirror.trim();
  }

  let suffix = "";
  if (year) {
    suffix += ` (${year})`;
  }
  if (doi) {
    suffix += ` [${doi}]`;
  }

  return { title, suffix };
};

const replaceIllegalCharacters = (value: string): string => {
  let result = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0;

    if (ILLEGAL_CHARACTERS.has(character) || codePoint < FIRST_PRINTABLE_CODE_POINT) {
      result += "_";
      continue;
    }

    result += character;
  }

  return result;
};

const sanitize = (value: string): string => {
  const cleaned = replaceIllegalCharacters(value)
    .replaceAll(/\s+/g, " ")
    .trim()
    // Windows silently drops trailing dots and spaces from a name.
    .replace(TRAILING_DOTS_AND_SPACES_PATTERN, "");

  if (WINDOWS_RESERVED_PATTERN.test(cleaned)) {
    return `_${cleaned}`;
  }

  return cleaned;
};

/**
 * Rebuilds the name a mirror sent into `Title (Year) [DOI].ext`, falling back
 * to the repaired original when the name has no recognizable structure.
 * Trimming happens at the end of the title, never at the start, and never at
 * the cost of the extension.
 */
export const buildDownloadFileName = (
  rawName: string,
  maxLength: number = MAX_FILE_NAME_LENGTH,
  preferredTitle = ""
): string => {
  const repaired = repairEncoding(rawName);
  const { stem, extension } = splitExtension(repaired);
  const metadata = readMetadata(stem);
  const { suffix } = metadata;

  // A caller that knows the real title beats anything derivable from the name.
  // LibGen elides long conference names mid-string - "[IEEE 2019 11th
  // International Conference on … (I...{Authors…" - so the title is genuinely
  // absent from the bytes, and no parsing recovers it. The year and DOI still
  // come from the name, which is where they are reliable.
  let title = metadata.title;
  if (preferredTitle.trim()) {
    title = preferredTitle.trim();
  }

  let extensionPart = "";
  if (extension) {
    extensionPart = `.${extension}`;
  }

  const titleBudget = Math.max(MIN_TITLE_LENGTH, maxLength - suffix.length - extensionPart.length);

  let name = sanitize(`${title.slice(0, titleBudget)}${suffix}`);
  if (name.length === 0) {
    name = "download";
  }

  if (name.length + extensionPart.length > maxLength) {
    name = sanitize(name.slice(0, Math.max(1, maxLength - extensionPart.length)));
  }

  return `${name}${extensionPart}`;
};

/**
 * `Name.pdf` -> `Name (2).pdf`, for when a different file already owns the name.
 */
export const withCollisionSuffix = (fileName: string, index: number): string => {
  const { stem, extension } = splitExtension(fileName);

  let extensionPart = "";
  if (extension) {
    extensionPart = `.${extension}`;
  }

  return `${stem} (${index})${extensionPart}`;
};
