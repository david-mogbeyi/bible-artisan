import { MAX_REFERENCE_INPUT_LENGTH } from '@bible-artisan/contracts';

/**
 * Pure, syntax-only parsing of a typed Bible reference (BIB-15, PRD §14). It knows nothing about
 * books or verse counts: it splits the input into a normalized book key and the numbers as the
 * user wrote them. `resolveParsedReference` (book-index.ts) matches the key against the edition's
 * corpus books and validates the numbers. Numbers are never adjusted here; `09` is 9, and 0 is
 * malformed.
 *
 * Supported shapes (B = book, optional `.` after it; spaces optional around `:` and `-`):
 *   B | B n | B n-n | B c:v | B c:v-v | B c:v-c:v
 * where `n` is a chapter, or a verse in a single-chapter book (decided by the resolver).
 */

/** The number part of a reference, exactly as typed. */
export type ReferenceSpec =
  | { form: 'book' }
  | { form: 'number'; first: number }
  | { form: 'number-range'; first: number; last: number }
  | { form: 'chapter-verse'; chapter: number; verse: number }
  | { form: 'verse-range'; chapter: number; verse: number; endVerse: number }
  | {
      form: 'chapter-verse-range';
      chapter: number;
      verse: number;
      endChapter: number;
      endVerse: number;
    };

/** What the book token was, before matching it to the corpus. */
export interface BookToken {
  /** Normalized key (see `normalizeBookKey`), e.g. `1tim`, `songofsolomon`. */
  key: string;
  /** Letters in the name without its numeric prefix; prefix matching needs at least two. */
  letters: number;
  /** The input contained `:`, so it was clearly meant as a reference. */
  hasColon: boolean;
}

export type ParsedReference =
  | ({ kind: 'reference'; spec: ReferenceSpec } & BookToken)
  /** Starts like a reference (a book token followed by a digit) but is not a complete one. */
  | ({ kind: 'malformed'; multiple: boolean } & BookToken)
  | { kind: 'not_reference' };

/** Zero-width space/joiners and the BOM: invisible, so never meaningful in a reference. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
/**
 * Hyphen and dash variants a range may be typed with: hyphen, non-breaking hyphen, figure dash,
 * en dash, em dash, horizontal bar (U+2010..U+2015), minus sign, small em dash, small and
 * full-width hyphen-minus.
 */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
/** Full-width ASCII (U+FF01..U+FF5E): digits, letters and punctuation typed with an IME. */
const FULL_WIDTH_ASCII = /[\uFF01-\uFF5E]/g;
const FULL_WIDTH_OFFSET = 0xfee0;
/**
 * Any numeric code point (Unicode N: Nd, Nl, No) other than ASCII 0-9, checked after full-width
 * digits have been folded. Superscripts, subscripts, circled and other-script digits are never
 * folded into a number: `Gen 1:1²` (a footnote marker) must not become Genesis 1:12.
 */
const FOREIGN_NUMBER = /(?![0-9])\p{N}/u;

/**
 * An explicit, minimal fold (deliberately not NFKC, which turns `²` into `2`): remove zero-width
 * characters, map full-width ASCII to ASCII, unify dashes, collapse every Unicode whitespace run
 * to one space, and lower-case ASCII letters only. Every other non-ASCII character is kept, so
 * the ASCII-only grammar rejects it.
 */
export function normalizeReferenceInput(input: string): string {
  return input
    .replace(ZERO_WIDTH, '')
    .replace(FULL_WIDTH_ASCII, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET))
    .replace(DASHES, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * The comparison key for any book name, abbreviation or code: the same fold, with whitespace
 * and periods removed (`1 Samuel` -> `1samuel`, `1Sa` -> `1sa`, `1SA` -> `1sa`).
 */
export function normalizeBookKey(name: string): string {
  return normalizeReferenceInput(name).replace(/[\s.]/gu, '');
}

// The book token: an optional numeric prefix (digit 1-3, space optional; or Roman I-III, space
// required so `Isaiah` stays a word), then space-separated ASCII words, then an optional `.`.
// Every repetition is separated by a mandatory single space (input is whitespace-collapsed), so
// no two quantifiers can match the same characters: matching stays linear, with no catastrophic
// backtracking.
const BOOK = String.raw`(?:([123]) ?|(i{1,3}) )?([a-z]+(?: [a-z]+)*)\.? ?`;
const NUM = String.raw`(\d{1,4})`;
const GRAMMAR = new RegExp(
  String.raw`^${BOOK}(?:${NUM}(?: ?: ?${NUM})?(?: ?- ?${NUM}(?: ?: ?${NUM})?)?)?$`,
);
/** A book token immediately followed by a digit: the start of a reference shape. */
const REFERENCE_START = new RegExp(String.raw`^${BOOK}\d`);
/**
 * A book token followed by a digit or a foreign numeric character (`Ps ²`, `Gen 1:1²`): looks like
 * a reference, but with a number the grammar never reads.
 */
const FOREIGN_NUMBER_START = new RegExp(String.raw`^${BOOK}(?:\d|\p{N})`, 'u');
/**
 * A list (`9:1,3`, `9:1; 10:2`) or a second book after a range dash (`16:27-1 Cor 1:1`,
 * `1:1-Gen 1:2`). A book needs at least two letters, so a verse-part suffix after the dash
 * (`9:1-3a`, `9:1-2b`) is malformed, not a second book.
 */
const MULTIPLE = /[,;]|\d ?- ?(?:[123] ?)?[a-z]{2}/;

const ROMAN: Readonly<Record<string, string>> = { i: '1', ii: '2', iii: '3' };

function bookToken(match: RegExpExecArray, hasColon: boolean): BookToken {
  const [, digit, roman, words = ''] = match;
  const prefix = digit ?? (roman ? ROMAN[roman] : undefined) ?? '';
  const letters = words.replace(/ /g, '');
  return { key: prefix + letters, letters: letters.length, hasColon };
}

function toNumber(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number.parseInt(text, 10);
}

function specOf(numbers: (number | undefined)[]): ReferenceSpec | undefined {
  const [a, b, c, d] = numbers;
  if (a === undefined) return { form: 'book' };
  if (b === undefined && c === undefined) return { form: 'number', first: a };
  if (b === undefined && d === undefined && c !== undefined) {
    return { form: 'number-range', first: a, last: c };
  }
  if (b !== undefined && c === undefined) return { form: 'chapter-verse', chapter: a, verse: b };
  if (b !== undefined && c !== undefined && d === undefined) {
    return { form: 'verse-range', chapter: a, verse: b, endVerse: c };
  }
  if (b !== undefined && c !== undefined && d !== undefined) {
    return { form: 'chapter-verse-range', chapter: a, verse: b, endChapter: c, endVerse: d };
  }
  // `B c-c:v` (chapter to verse): outside the supported grammar.
  return undefined;
}

export function parseReference(input: string): ParsedReference {
  // The DTO caps input at this length; the cap here keeps the function safe for other callers.
  if (input.length > MAX_REFERENCE_INPUT_LENGTH) return { kind: 'not_reference' };
  const text = normalizeReferenceInput(input);
  const hasColon = text.includes(':');

  if (FOREIGN_NUMBER.test(text)) {
    const start = FOREIGN_NUMBER_START.exec(text);
    return start
      ? { kind: 'malformed', multiple: false, ...bookToken(start, hasColon) }
      : { kind: 'not_reference' };
  }

  const match = GRAMMAR.exec(text);
  if (match) {
    const numbers = [match[4], match[5], match[6], match[7]].map(toNumber);
    const spec = specOf(numbers);
    if (spec && !numbers.includes(0))
      return { kind: 'reference', spec, ...bookToken(match, hasColon) };
    return { kind: 'malformed', multiple: false, ...bookToken(match, hasColon) };
  }

  const start = REFERENCE_START.exec(text);
  if (start)
    return { kind: 'malformed', multiple: MULTIPLE.test(text), ...bookToken(start, hasColon) };
  return { kind: 'not_reference' };
}

/** The number part re-rendered in plain ASCII (`9:1-5`), for ambiguous candidates' inputs. */
export function formatSpec(spec: ReferenceSpec): string {
  switch (spec.form) {
    case 'book':
      return '';
    case 'number':
      return `${spec.first}`;
    case 'number-range':
      return `${spec.first}-${spec.last}`;
    case 'chapter-verse':
      return `${spec.chapter}:${spec.verse}`;
    case 'verse-range':
      return `${spec.chapter}:${spec.verse}-${spec.endVerse}`;
    case 'chapter-verse-range':
      return `${spec.chapter}:${spec.verse}-${spec.endChapter}:${spec.endVerse}`;
  }
}
