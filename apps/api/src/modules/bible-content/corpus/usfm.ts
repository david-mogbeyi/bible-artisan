/**
 * USFM (https://ubsicap.github.io/usfm/) to verse text, for the markers the WEB artifact uses.
 * An explicit allowlist: a marker not listed here fails the import instead of being guessed at,
 * so a new publisher release that starts using another marker cannot silently change wording.
 *
 * Rules (ADR 0001, BIB-14 addendum):
 * - Notes are dropped with their content: footnotes `\f … \f*`, cross references `\x … \x*`.
 * - Heading lines are dropped whole: book identification and titles, section headings, speaker
 *   labels (`\sp`), chapter labels. They are not part of any verse; a heading line that also opens
 *   a chapter or verse is refused.
 * - Superscriptions (`\d`: Psalm titles and Psalm 119 stanza headings) are published text but not
 *   verse text: each is kept, under the same rules as verse text, as a separate superscription of
 *   the verse that immediately follows it in the same chapter. A `\d` must be a whole line of its
 *   own inside a chapter and must be followed by a verse before the next `\d`, `\c`, or the end of
 *   the book; anything else is refused.
 * - Character markers are dropped, their content kept: `\w` (Strong's attributes removed),
 *   `\wj` (words of Jesus), `\qs` (Selah), `\bk` (book title), and their nested `\+` forms. An
 *   opening marker consumes the one whitespace character after it, which USFM defines as the
 *   marker's delimiter, not content. A closing `…*` marker consumes nothing.
 * - Paragraph and poetry markers become a word boundary.
 * - Runs of ASCII whitespace collapse to one space and the ends are trimmed. Nothing else changes:
 *   punctuation, curly quotes, and the publisher's no-break spaces (U+00A0) are kept, which is
 *   why this never uses JavaScript's `\s` or `trim()` (both treat U+00A0 as whitespace).
 */

/** The publisher's text could not be read under the rules above. */
export class UsfmFormatError extends Error {
  readonly code = 'CORPUS_USFM_FORMAT';
}

export interface UsfmVerse {
  chapter: number;
  verse: number;
  text: string;
}

/** A `\d` line, attached to the verse it immediately precedes. */
export interface UsfmSuperscription {
  chapter: number;
  beforeVerse: number;
  text: string;
}

export interface UsfmBook {
  /** USFM book code from `\id` (e.g. `GEN`). */
  code: string;
  /** Publisher's short book name (`\toc2`). */
  name: string;
  /** Publisher's book abbreviation (`\toc3`). */
  abbreviation: string;
  /** Verses in source order. */
  verses: UsfmVerse[];
  /** Superscriptions in source order. */
  superscriptions: UsfmSuperscription[];
}

const HEADING_MARKERS = new Set([
  'id',
  'ide',
  'h',
  'toc1',
  'toc2',
  'toc3',
  'mt1',
  'mt2',
  'mt3',
  'ms1',
  's',
  'sp',
  'cl',
]);
const PARAGRAPH_MARKERS = new Set(['p', 'q1', 'q2', 'm', 'b', 'li1', 'pi1', 'mi', 'nb']);
const CHARACTER_MARKERS = new Set(['w', 'wj', 'qs', 'bk']);

const HEADING_LINE = /^\\([a-z]+[0-9]*)(?:[ \t]+(.*))?$/;
const CHAPTER_OR_VERSE = /\\[cv][ \t]/;
const ASCII_WHITESPACE = /[ \t\r\n]+/g;
const ASCII_WHITESPACE_CHAR = /^[ \t\r\n]/;
const MARKER = /(\\\+?[a-z]+[0-9]*\*?)/;
const NUMBER_DELIMITED = /^[ \t\r\n]+([0-9]+)(?:[ \t\r\n]|$)/;
const BOOK_CODE = /^[1-4A-Z][A-Z0-9]{2}$/;
const SUPERSCRIPTION_MARKER = /\\\+?d(?![a-z0-9])/g;
const SUPERSCRIPTION_LINE = /^\\d[ \t]/;

/** Collapses ASCII whitespace runs to one space and trims ASCII spaces only. */
export function collapseAsciiWhitespace(text: string): string {
  return text.replace(ASCII_WHITESPACE, ' ').replace(/^ /, '').replace(/ $/, '');
}

/**
 * The book code from the file's `\id` line, without parsing the rest, so non-Scripture books
 * (front matter, glossary, which use markers outside the allowlist) can be skipped by code.
 */
export function usfmBookCode(source: string): string {
  const code = /^\\id[ \t]+([^ \t\r\n]+)/m.exec(source.replace(/^\uFEFF/, ''))?.[1];
  if (!code || !BOOK_CODE.test(code)) throw new UsfmFormatError('missing or invalid \\id');
  return code;
}

export function parseUsfmBook(source: string): UsfmBook {
  let code: string | undefined;
  let name = '';
  let abbreviation = '';
  const body: string[] = [];

  for (const line of source.replace(/^\uFEFF/, '').split('\n')) {
    // A `\d` is only ever a whole line: exactly one marker, at the start.
    const superscriptionMarkers = line.match(SUPERSCRIPTION_MARKER)?.length ?? 0;
    if (superscriptionMarkers > (SUPERSCRIPTION_LINE.test(line) ? 1 : 0)) {
      throw new UsfmFormatError('a superscription marker that is not a line of its own');
    }
    if (SUPERSCRIPTION_LINE.test(line) && CHAPTER_OR_VERSE.test(line)) {
      throw new UsfmFormatError('a superscription line opens a chapter or verse');
    }
    const heading = HEADING_LINE.exec(line.replace(/\r$/, ''));
    if (!heading || !HEADING_MARKERS.has(heading[1] ?? '')) {
      body.push(line);
      continue;
    }
    if (CHAPTER_OR_VERSE.test(line)) {
      throw new UsfmFormatError('a heading line opens a chapter or verse');
    }
    const content = collapseAsciiWhitespace(heading[2] ?? '');
    if (heading[1] === 'id') code = content.split(' ')[0];
    if (heading[1] === 'toc2') name = content;
    if (heading[1] === 'toc3') abbreviation = content;
  }
  if (!code || !BOOK_CODE.test(code)) throw new UsfmFormatError('missing or invalid \\id');
  if (!name || !abbreviation || /[\\|]/.test(name + abbreviation)) {
    throw new UsfmFormatError('missing or invalid \\toc2 / \\toc3');
  }

  const text = body
    .join('\n')
    .replace(/\\f .*?\\f\*/gs, '')
    .replace(/\\x .*?\\x\*/gs, '')
    // Word-level attributes (`\w word|strong="H1234"\w*`): only `\w` carries them in this text.
    .replace(/\|[^\\]*(?=\\\+?w\*)/g, '');

  const verses: UsfmVerse[] = [];
  const superscriptions: UsfmSuperscription[] = [];
  const seen = new Set<string>();
  let chapter = 0;
  /** Where text goes: the open verse or superscription. */
  let current: { text: string } | undefined;
  /** A superscription waiting for the verse it precedes. */
  let pending: UsfmSuperscription | undefined;
  let consumeDelimiter = false;

  const parts = text.split(MARKER);
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? '';
    if (i % 2 === 0) {
      // Text between markers.
      if (consumeDelimiter && ASCII_WHITESPACE_CHAR.test(part)) part = part.slice(1);
      consumeDelimiter = false;
      if (current) current.text += part;
      else if (collapseAsciiWhitespace(part) !== '') {
        throw new UsfmFormatError('text outside any verse or superscription');
      }
      continue;
    }

    const closing = part.endsWith('*');
    const markerName = part.replace(/^\\\+?/, '').replace(/\*$/, '');
    consumeDelimiter = false;

    if (closing) {
      if (!CHARACTER_MARKERS.has(markerName)) throw new UsfmFormatError('unsupported marker');
      continue;
    }
    if (markerName === 'c' || markerName === 'v') {
      // The number is the start of the next text part: `\v 12 In the…`.
      const next = parts[i + 1] ?? '';
      const match = NUMBER_DELIMITED.exec(next);
      if (!match) throw new UsfmFormatError('malformed chapter or verse number (or a bridge)');
      const number = Number(match[1]);
      parts[i + 1] = next.slice(match[0].length);
      if (markerName === 'c') {
        if (pending) throw new UsfmFormatError('a superscription is not followed by a verse');
        chapter = number;
        current = undefined;
      } else {
        if (chapter === 0) throw new UsfmFormatError('verse before any chapter');
        const key = `${chapter}:${number}`;
        if (seen.has(key)) throw new UsfmFormatError('duplicate verse');
        seen.add(key);
        if (pending) {
          pending.beforeVerse = number;
          superscriptions.push(pending);
          pending = undefined;
        }
        const verse: UsfmVerse = { chapter, verse: number, text: '' };
        verses.push(verse);
        current = verse;
      }
      continue;
    }
    if (markerName === 'd') {
      if (chapter === 0) throw new UsfmFormatError('superscription before any chapter');
      if (pending) throw new UsfmFormatError('a superscription is not followed by a verse');
      pending = { chapter, beforeVerse: 0, text: '' };
      current = pending;
      continue;
    }
    if (CHARACTER_MARKERS.has(markerName)) {
      consumeDelimiter = true;
      continue;
    }
    if (PARAGRAPH_MARKERS.has(markerName)) {
      // A superscription is one line: the next paragraph marker closes it.
      if (current && current === pending) current = undefined;
      else if (current) current.text += ' ';
      continue;
    }
    throw new UsfmFormatError('unsupported marker');
  }

  if (pending) throw new UsfmFormatError('a superscription is not followed by a verse');
  for (const verse of verses) verse.text = collapseAsciiWhitespace(verse.text);
  for (const line of superscriptions) line.text = collapseAsciiWhitespace(line.text);
  return { code, name, abbreviation, verses, superscriptions };
}
