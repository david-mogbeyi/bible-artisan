import { MAX_SEARCH_TOKENS, type SearchMode } from '@bible-artisan/contracts';

/**
 * The one definition of what a search matches (BIB-16, PRD §14, FR-BIBLE-004/005). PostgreSQL
 * full-text search only narrows the candidates; every result is decided here, against the verse
 * text exactly as stored, so a result is never shown on the strength of the index alone.
 *
 * - A *token* is a maximal run of Unicode letters, marks or digits, compared lower-cased.
 *   Everything between two tokens is their *separator*.
 * - `terms`: every distinct query token is one of the verse's tokens (AND, whole words).
 * - `phrase`: the query tokens are consecutive verse tokens, and each separator between them is
 *   equal to the query's after `canonicalSeparator`. Whitespace (NBSP included), quotation marks,
 *   apostrophes and hyphens are neutral; any other punctuation must match. So a phrase never
 *   matches across a full stop or comma the user did not type: normalization never invents
 *   adjacency. Punctuation before the first or after the last query token is ignored.
 *
 * Highlights are `[start, end)` offsets into the stored text, in Unicode code points (PRD §14
 * counts selection offsets in code points); the text itself is never rebuilt.
 */

/** Soft hyphen, zero-width space/joiners, word joiner and BOM: invisible in typed input. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
/** Full-width ASCII (U+FF01..U+FF5E), as typed with an IME. */
const FULL_WIDTH_ASCII = /[\uFF01-\uFF5E]/g;
const FULL_WIDTH_OFFSET = 0xfee0;
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;
/** Neutral in a separator: whitespace (JavaScript `\s` includes U+00A0) and invisible marks. */
const NEUTRAL_SPACE = /[\s\u00AD\u200B-\u200D\u2060\uFEFF]/gu;
/** Quotation marks and apostrophes, straight and typographic. */
const QUOTES = /["'`\u00AB\u00B4\u00BB\u2018-\u201F\u2032\u2033\u2039\u203A]/g;
/** Hyphen-minus, hyphen, non-breaking hyphen: they join words (`Beth-shemesh`). */
const HYPHENS = /[-\u2010\u2011]/g;
/** Figure dash, en dash, em dash, horizontal bar, minus sign: one dash. */
const DASHES = /[\u2012-\u2015\u2212]/g;

export interface Token {
  /** Lower-cased token text. */
  norm: string;
  /** UTF-16 offsets into the source string. */
  start: number;
  end: number;
}

export interface Tokenized {
  tokens: Token[];
  /** `separators[i]` (canonical) lies between `tokens[i]` and `tokens[i + 1]`. */
  separators: string[];
}

export interface SearchQuery {
  mode: SearchMode;
  /** Query tokens in order (phrase) or distinct, in order of first appearance (terms). */
  tokens: string[];
  /** Phrase mode: the canonical separators between consecutive tokens. Empty for terms. */
  separators: string[];
}

export type QueryProblem = 'no_words' | 'too_many_words';

/** A half-open `[start, end)` range, in UTF-16 units until `toCodePointRanges`. */
export interface Range {
  start: number;
  end: number;
}

/** NFC, invisible characters removed, full-width ASCII folded to ASCII. Queries only. */
export function foldQuery(input: string): string {
  return input
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(FULL_WIDTH_ASCII, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET));
}

/** What must match between two consecutive phrase tokens. */
export function canonicalSeparator(raw: string): string {
  if (raw === ' ') return ''; // by far the commonest separator
  return raw
    .replace(NEUTRAL_SPACE, '')
    .replace(QUOTES, '')
    .replace(HYPHENS, '')
    .replace(DASHES, '—');
}

function tokensOf(text: string): Token[] {
  return Array.from(text.matchAll(TOKEN), (match) => ({
    norm: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** The canonical separator between two tokens of `text`. */
function separatorBetween(text: string, before: Token, after: Token): string {
  return canonicalSeparator(text.slice(before.end, after.start));
}

export function tokenize(text: string): Tokenized {
  const tokens = tokensOf(text);
  const separators = tokens
    .slice(1)
    .map((token, i) => separatorBetween(text, tokens[i] ?? token, token));
  return { tokens, separators };
}

/** Parses typed input into a query, or names why it cannot be searched. */
export function parseSearchQuery(input: string, mode: SearchMode): SearchQuery | QueryProblem {
  const { tokens, separators } = tokenize(foldQuery(input));
  if (tokens.length === 0) return 'no_words';
  if (tokens.length > MAX_SEARCH_TOKENS) return 'too_many_words';
  const norms = tokens.map((token) => token.norm);
  return mode === 'phrase'
    ? { mode, tokens: norms, separators }
    : { mode, tokens: [...new Set(norms)], separators: [] };
}

/**
 * The verse's match ranges (UTF-16), or null when the verse does not match. Terms: every
 * occurrence of a query token. Phrase: each non-overlapping occurrence, first token to last.
 */
export function matchVerse(query: SearchQuery, text: string): Range[] | null {
  const tokens = tokensOf(text);
  return query.mode === 'phrase' ? matchPhrase(query, text, tokens) : matchTerms(query, tokens);
}

function matchTerms(query: SearchQuery, tokens: Token[]): Range[] | null {
  const present = new Set(tokens.map((token) => token.norm));
  if (!query.tokens.every((token) => present.has(token))) return null;
  const wanted = new Set(query.tokens);
  return tokens.filter((token) => wanted.has(token.norm)).map(({ start, end }) => ({ start, end }));
}

function matchPhrase(query: SearchQuery, text: string, tokens: Token[]): Range[] | null {
  const k = query.tokens.length;
  const ranges: Range[] = [];
  let i = 0;
  while (i + k <= tokens.length) {
    if (phraseAt(query, text, tokens, i)) {
      const first = tokens[i];
      const last = tokens[i + k - 1];
      if (first && last) ranges.push({ start: first.start, end: last.end });
      i += k;
    } else {
      i += 1;
    }
  }
  return ranges.length > 0 ? ranges : null;
}

/** Separators are canonicalized only where the words already match (the hot path skips them). */
function phraseAt(query: SearchQuery, text: string, tokens: Token[], i: number): boolean {
  for (let j = 0; j < query.tokens.length; j++) {
    const token = tokens[i + j];
    if (!token || token.norm !== query.tokens[j]) return false;
    const previous = tokens[i + j - 1];
    if (j > 0 && previous && separatorBetween(text, previous, token) !== query.separators[j - 1]) {
      return false;
    }
  }
  return true;
}

/** Converts UTF-16 ranges into code-point ranges over the same text. */
export function toCodePointRanges(text: string, ranges: readonly Range[]): Range[] {
  if (!/[\uD800-\uDBFF]/.test(text)) return ranges.map(({ start, end }) => ({ start, end }));
  const at = (unit: number): number => Array.from(text.slice(0, unit)).length;
  return ranges.map(({ start, end }) => ({ start: at(start), end: at(end) }));
}
