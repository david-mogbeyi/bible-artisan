import {
  type AnchorSelection,
  type BiblePassageResponse,
  joinAnchorQuote,
} from '@bible-artisan/contracts';

/**
 * Reader selection → anchor selection (BIB-18, PRD section 14). The durable unit is Unicode code
 * points into the stored verse text, never DOM or UTF-16 offsets. Only elements carrying
 * `data-verse-text` count: verse numbers, checkboxes, superscriptions and "no text" notes are
 * outside them and are ignored. Every function returns null rather than guess.
 */

/** The attribute on the element that holds exactly one verse's stored text. */
export const VERSE_TEXT_ATTRIBUTE = 'data-verse-text';

type Segment = AnchorSelection['segments'][number];

/** Characters trimmed from the ends of a pointer selection (by offset, never from the text). */
const isSpace = (ch: string | undefined) => ch === ' ' || ch === ' ';

/**
 * A UTF-16 offset as a code-point offset. An offset inside a surrogate pair (the browser never
 * produces one, but a script can) rounds outward: `floor` for a start, `ceil` for an end, so the
 * whole character is kept.
 */
export function codePointOffset(text: string, utf16: number, round: 'floor' | 'ceil'): number {
  let units = 0;
  let points = 0;
  for (const ch of text) {
    if (units >= utf16) break;
    if (units + ch.length > utf16) return round === 'floor' ? points : points + 1;
    units += ch.length;
    points += 1;
  }
  return points;
}

/** UTF-16 length of the text from the start of `element` to a boundary point inside it. */
function utf16Within(element: Element, node: Node, offset: number): number {
  const range = element.ownerDocument.createRange();
  range.setStart(element, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function versesByNumber(passage: BiblePassageResponse): Map<number, string> {
  return new Map(passage.verses.map((v) => [v.verse, v.text]));
}

function sliceOf(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}

function phrase(
  passage: BiblePassageResponse,
  segments: Segment[],
  texts: Map<number, string>,
): AnchorSelection {
  return {
    editionId: passage.edition.id,
    bookCode: passage.book.code,
    kind: 'phrase',
    segments,
    quote: joinAnchorQuote(segments.map((s) => sliceOf(texts.get(s.verse) ?? '', s.start, s.end))),
  };
}

/**
 * A DOM Range over the reader's verse list as a phrase selection, or null when it selects no
 * verse text. Leading and trailing spaces are trimmed by moving offsets, and verses left empty at
 * either end are dropped. Refuses (null) if an element's text is not exactly the stored verse.
 */
export function phraseFromRange(
  range: Range,
  root: Element,
  passage: BiblePassageResponse,
): AnchorSelection | null {
  if (range.collapsed) return null;
  const texts = versesByNumber(passage);
  const segments: Segment[] = [];
  for (const element of root.querySelectorAll(`[${VERSE_TEXT_ATTRIBUTE}]`)) {
    if (!range.intersectsNode(element)) continue;
    const verse = Number(element.getAttribute(VERSE_TEXT_ATTRIBUTE));
    const text = texts.get(verse);
    if (text === undefined || element.textContent !== text) return null;
    const startUnits = element.contains(range.startContainer)
      ? utf16Within(element, range.startContainer, range.startOffset)
      : 0;
    const endUnits = element.contains(range.endContainer)
      ? utf16Within(element, range.endContainer, range.endOffset)
      : text.length;
    segments.push({
      chapter: passage.chapter,
      verse,
      start: codePointOffset(text, startUnits, 'floor'),
      end: codePointOffset(text, endUnits, 'ceil'),
    });
  }
  const trimmed = trim(segments, texts);
  return trimmed.length > 0 ? phrase(passage, trimmed, texts) : null;
}

/**
 * One Range from the earliest start to the latest end of `ranges`, or null when there are none.
 * Firefox splits a pointer selection into several ranges around `user-select: none` nodes (the
 * verse checkbox and number), in no guaranteed order; the selection the user made spans them all.
 */
export function spanOfRanges(ranges: readonly Range[]): Range | null {
  let first: Range | null = null;
  let last: Range | null = null;
  for (const r of ranges) {
    if (!first || r.compareBoundaryPoints(Range.START_TO_START, first) < 0) first = r;
    if (!last || r.compareBoundaryPoints(Range.END_TO_END, last) > 0) last = r;
  }
  if (!first || !last) return null;
  const span = first.cloneRange();
  span.setEnd(last.endContainer, last.endOffset);
  return span;
}

/** The ranges of a native selection, as a list (one in most browsers, several in Firefox). */
export function rangesOf(selection: Selection): Range[] {
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
}

/** A selection's boundary points: compared by identity and offset, never by text. */
export type Boundaries = readonly (readonly [Node, number, Node, number])[];

export function boundariesOf(ranges: readonly Range[]): Boundaries {
  return ranges.map((r) => [r.startContainer, r.startOffset, r.endContainer, r.endOffset] as const);
}

export function sameBoundaries(a: Boundaries, b: Boundaries): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return y !== undefined && x[0] === y[0] && x[1] === y[1] && x[2] === y[2] && x[3] === y[3];
    })
  );
}

/** Field-by-field equality of two selections (no serialization). */
export function sameAnchorSelection(a: AnchorSelection, b: AnchorSelection): boolean {
  return (
    a.editionId === b.editionId &&
    a.bookCode === b.bookCode &&
    a.kind === b.kind &&
    a.segments.length === b.segments.length &&
    a.segments.every((s, i) => {
      const t = b.segments[i];
      return (
        t !== undefined &&
        s.chapter === t.chapter &&
        s.verse === t.verse &&
        s.start === t.start &&
        s.end === t.end
      );
    }) &&
    a.quote === b.quote
  );
}

function trim(segments: Segment[], texts: Map<number, string>): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  const chars = (s: Segment) => Array.from(texts.get(s.verse) ?? '');
  while (out.length > 0) {
    const first = out[0] as Segment;
    const cs = chars(first);
    while (first.start < first.end && isSpace(cs[first.start])) first.start += 1;
    if (first.start < first.end) break;
    out.shift();
  }
  while (out.length > 0) {
    const last = out[out.length - 1] as Segment;
    const cs = chars(last);
    while (last.end > last.start && isSpace(cs[last.end - 1])) last.end -= 1;
    if (last.end > last.start) break;
    out.pop();
  }
  return out;
}

/** Whole verses chosen with the checkboxes: null if none, `not_contiguous` if there is a gap. */
export function versesSelection(
  passage: BiblePassageResponse,
  verses: readonly number[],
): AnchorSelection | 'not_contiguous' | null {
  if (verses.length === 0) return null;
  const sorted = [...new Set(verses)].sort((a, b) => a - b);
  const first = sorted[0] as number;
  if (sorted[sorted.length - 1] !== first + sorted.length - 1) return 'not_contiguous';
  const texts = versesByNumber(passage);
  const segments = sorted.map((verse) => ({
    chapter: passage.chapter,
    verse,
    start: 0,
    end: Array.from(texts.get(verse) ?? '').length,
  }));
  return {
    editionId: passage.edition.id,
    bookCode: passage.book.code,
    kind: 'verses',
    segments,
    quote: joinAnchorQuote(sorted.map((v) => texts.get(v) ?? '')),
  };
}

/** A verse's words: runs between U+0020 spaces, verbatim, with code-point offsets. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

export function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  let start = 0;
  const chars = Array.from(text);
  chars.forEach((ch, i) => {
    if (ch !== ' ') return;
    if (i > start) words.push({ text: chars.slice(start, i).join(''), start, end: i });
    start = i + 1;
  });
  if (chars.length > start) {
    words.push({ text: chars.slice(start).join(''), start, end: chars.length });
  }
  return words;
}

export interface WordPoint {
  verse: number;
  /** Index into `wordsOf(verse text)`. */
  word: number;
}

/**
 * The keyboard path: a phrase from one word to another, possibly across verses. Null when the
 * end comes before the start or a word does not exist.
 */
export function phraseFromWords(
  passage: BiblePassageResponse,
  from: WordPoint,
  to: WordPoint,
): AnchorSelection | null {
  const texts = versesByNumber(passage);
  const first = wordsOf(texts.get(from.verse) ?? '')[from.word];
  const last = wordsOf(texts.get(to.verse) ?? '')[to.word];
  if (!first || !last) return null;
  if (to.verse < from.verse || (to.verse === from.verse && to.word < from.word)) return null;
  const segments: Segment[] = [];
  for (let verse = from.verse; verse <= to.verse; verse += 1) {
    const length = Array.from(texts.get(verse) ?? '').length;
    segments.push({
      chapter: passage.chapter,
      verse,
      start: verse === from.verse ? first.start : 0,
      end: verse === to.verse ? last.end : length,
    });
  }
  return phrase(passage, segments, texts);
}
