/**
 * The one fold applied to everything a user types into a Bible input, before the reference parser
 * (BIB-15) or the search tokenizer (BIB-16) reads it, so both see the same characters: an input
 * is a reference in `POST /bible/resolve` exactly when search treats it as one.
 *
 * - NFC: canonically equivalent spellings are the same text (a decomposed `é`, the Kelvin sign
 *   U+212A, which is canonically `K`). Deliberately not NFKC: compatibility characters such as `²`
 *   or `Ⅱ` stay as typed, so a footnote marker never becomes a digit.
 * - Invisible characters are removed (see `INVISIBLE_INPUT_CHARS`).
 * - Full-width ASCII (U+FF01..U+FF5E, as typed with an IME) becomes ASCII.
 */

/**
 * Invisible in typed input and never meaningful: soft hyphen (U+00AD), zero-width space,
 * non-joiner and joiner (U+200B..U+200D), word joiner (U+2060), and the BOM / zero-width no-break
 * space (U+FEFF).
 */
export const INVISIBLE_INPUT_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

const FULL_WIDTH_ASCII = /[\uFF01-\uFF5E]/g;
const FULL_WIDTH_OFFSET = 0xfee0;

export function foldTypedInput(input: string): string {
  return input
    .normalize('NFC')
    .replace(INVISIBLE_INPUT_CHARS, '')
    .replace(FULL_WIDTH_ASCII, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET));
}
