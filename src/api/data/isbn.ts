/**
 * ISBNs as LibGen stores them: bare digits. A publisher prints
 * `978-3-642-12020-6`, and searching LibGen with the dashes finds nothing, so
 * a typed ISBN is reduced to its digits first. Checksums are verified, so a
 * mistyped number is never searched as if it were an ISBN.
 */

const ISBN_SHAPE = /^(?:isbn(?:-1[03])?[\s:]*)?([\dXx][\d\s-]{8,20}[\dXx])$/i;

const isbn10Valid = (digits: string): boolean => {
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const character = digits[index];
    let value = Number(character);
    if (character === "X") {
      if (index !== 9) {
        return false;
      }
      value = 10;
    }
    sum += value * (10 - index);
  }
  return sum % 11 === 0;
};

const isbn13CheckDigit = (first12: string): number => {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    // Weights alternate 1, 3, 1, 3...
    sum += Number(first12[index]) * (1 + 2 * (index % 2));
  }
  return (10 - (sum % 10)) % 10;
};

const isbn13Valid = (digits: string): boolean =>
  /^97[89]\d{10}$/.test(digits) && isbn13CheckDigit(digits.slice(0, 12)) === Number(digits[12]);

/** The bare digits of an ISBN-10 or ISBN-13, or undefined if `raw` is not one. */
export const normalizeISBN = (raw: string): string | undefined => {
  const shaped = raw.trim().match(ISBN_SHAPE);
  if (!shaped) {
    return undefined;
  }
  const digits = shaped[1].replaceAll(/[\s-]/g, "").toUpperCase();
  if (digits.length === 13 && isbn13Valid(digits)) {
    return digits;
  }
  if (digits.length === 10 && /^\d{9}[\dX]$/.test(digits) && isbn10Valid(digits)) {
    return digits;
  }
  return undefined;
};

/** The ISBN-13 form of a valid ISBN-10 or ISBN-13. */
export const isbn13 = (digits: string): string => {
  if (digits.length === 13) {
    return digits;
  }
  const first12 = `978${digits.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
};
