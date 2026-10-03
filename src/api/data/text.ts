/**
 * Titles and venues arrive with markup and HTML entities from more than one
 * place: Crossref's JATS (`<scp>`, `<i>`, `<sup>`), LibGen's copies of the
 * same titles, and entities like `&amp;` from both. Measured on the NAS queue
 * database (2026-10-03): 86 rows with entities - some in file names on disk,
 * `T&amp;I engine (2011) [...].pdf` - 4 with markup and 35 with runs of
 * spaces. `cleanText` is the one place that turns any of them into plain text.
 */

// Marks whitespace that is layout around a tag rather than a space in the text.
const LAYOUT = "\u0000";

// Only markup the sources actually use: JATS and HTML inline tags, and
// MathML. Anything else in angle brackets is text - a file named
// "Notes <draft>.pdf" keeps its "<draft>".
const TAG_NAMES = [
  "scp",
  "sc",
  "i",
  "b",
  "em",
  "strong",
  "u",
  "sup",
  "sub",
  "span",
  "font",
  "br",
  "p",
  "title",
  "italic",
  "bold",
  "sans-serif",
  "inline-formula",
  "tex-math",
  String.raw`mml:[a-z]+`,
  String.raw`jats:[a-z]+`,
].join("|");
const TAG = String.raw`</?(?:${TAG_NAMES})(?:\s[^>]*)?/?>`;

/**
 * Whitespace beside a tag is layout when it breaks a line (Crossref
 * pretty-prints JATS with a newline and indent around every tag) or is a run
 * of two or more spaces (LibGen's copies, where those newlines became spaces).
 * A single space beside a tag is a real space: `Run <i>DOOM</i>`.
 */
const markLayout = (value: string): string =>
  value
    .replaceAll(new RegExp(String.raw`(?:\s*\n\s*|\s{2,})(?=${TAG})`, "giu"), LAYOUT)
    .replaceAll(new RegExp(String.raw`(?<=${TAG})(?:\s*\n\s*|\s{2,})`, "giu"), LAYOUT);

/**
 * Small caps are written as a capital and the rest in `<scp>`. Between two
 * such words, layout hides whether there was a space: `C<scp>onsistent</scp>
 * Z<scp>oom</scp>` is "ConsistentZoom", but `L<scp>EVEL</scp> S<scp>ET</scp>`
 * is "LEVEL SET". Upper-case small caps are a heading in capitals, so its
 * words are separate; lower-case ones are one camel-cased name.
 */
const joinSmallCaps = (value: string): string =>
  value.replaceAll(
    new RegExp(`<scp>([^<]*)</scp>${LAYOUT}(?=[A-Z]${LAYOUT}?<scp>)`, "gu"),
    (_match, inner: string) => {
      const isCapitals = /[A-Z]/u.test(inner) && inner === inner.toUpperCase();
      if (isCapitals) {
        return `<scp>${inner}</scp> `;
      }
      return `<scp>${inner}</scp>`;
    }
  );

const CLOSING_TAG_AT_END = new RegExp(String.raw`</(?:${TAG_NAMES})>$`, "iu");
const OPENING_TAG_AT_START = new RegExp(String.raw`^<(?:${TAG_NAMES})(?:\s[^>]*)?>`, "iu");
// A lone letter starts a word the markup finishes: small caps (`L<scp>EVEL`)
// or a symbol (`D<sup>3</sup>`).
const LONE_LETTER_AT_END = /(?:^|[^\p{L}\p{N}])\p{L}$/u;
const WORD_CHARACTER_AT_START = /^[\p{L}\p{N}]/u;

/**
 * What layout stood for, read from either side of it. After a closing tag it
 * is a space before a word (`<sup>2</sup>⏎space curves`) and nothing before
 * another tag or punctuation (`<i>N</i>⏎‐PolyVector`). Before an opening tag
 * it is a space after a word (`Designing⏎<i>N</i>`) and nothing after a lone
 * letter or at the start.
 */
const resolveLayout = (value: string): string =>
  value.replaceAll(LAYOUT, (_match: string, offset: number) => {
    const before = value.slice(0, offset);
    const after = value.slice(offset + 1);
    if (CLOSING_TAG_AT_END.test(before)) {
      if (WORD_CHARACTER_AT_START.test(after)) {
        return " ";
      }
      return "";
    }
    if (OPENING_TAG_AT_START.test(after)) {
      if (before.trim() === "" || LONE_LETTER_AT_END.test(before)) {
        return "";
      }
      return " ";
    }
    return " ";
  });

/**
 * A lower-case letter run straight into an italic capitalised word is a
 * dropped space - "Special Issue of the<i>Journal of Graphics Tools</i>" in
 * Crossref's own record. Small caps are `<scp>` and symbols are single
 * letters (`<i>L</i>`), so neither matches.
 */
const ITALIC_NAME_AFTER_WORD = /(?<=\p{Ll})(?=<(?:i|em|italic)>\p{Lu}\p{Ll})/gu;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  minus: "−",
  szlig: "ß",
  aelig: "æ",
  AElig: "Æ",
  oslash: "ø",
  Oslash: "Ø",
  eth: "ð",
  thorn: "þ",
};

// `&eacute;`, `&iuml;`, `&ccedil;`... from the letter and the accent's name.
const ACCENTS: Record<string, string> = {
  grave: "̀",
  acute: "́",
  circ: "̂",
  tilde: "̃",
  uml: "̈",
  ring: "̊",
  cedil: "̧",
};

const decodeNamed = (name: string): string | undefined => {
  if (name in NAMED) {
    return NAMED[name];
  }
  const accent = /^([A-Za-z])(grave|acute|circ|tilde|uml|ring|cedil)$/u.exec(name);
  if (accent) {
    return (accent[1] + ACCENTS[accent[2]]).normalize("NFC");
  }
  return undefined;
};

const decodeEntities = (value: string): string =>
  value.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return decodeNamed(body) ?? match;
  });

/**
 * Plain text from a title, venue or name: markup removed (its layout
 * whitespace read as a space or nothing), entities decoded, whitespace
 * collapsed. Tags are stripped before entities are decoded, so an encoded
 * `&lt;i&gt;` stays text.
 */
export const cleanText = (value: string): string =>
  decodeEntities(
    resolveLayout(joinSmallCaps(markLayout(value)))
      .replaceAll(ITALIC_NAME_AFTER_WORD, " ")
      .replaceAll(new RegExp(TAG, "giu"), "")
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
