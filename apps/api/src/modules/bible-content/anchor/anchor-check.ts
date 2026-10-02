import { type AnchorKind, type AnchorProblemCode, joinAnchorQuote } from '@bible-artisan/contracts';
import type { IndexBook } from '../reference/book-index';

/**
 * The anchor rules (BIB-18, PRD section 14), as pure functions over the book index and the stored
 * verse rows, so every rule is unit-tested without a database. Offsets are Unicode code points
 * into the stored text. Each check returns the first problem it finds, or null; nothing here ever
 * adjusts an offset, a verse or the quote to make an anchor fit.
 */

export interface AnchorSegmentInput {
  chapter: number;
  verse: number;
  start: number;
  end: number;
  /** Present on a stored anchor (resolve); absent on a fresh selection (capture). */
  textSha256?: string;
}

export interface AnchorInput {
  kind: AnchorKind;
  segments: readonly AnchorSegmentInput[];
  quote: string;
}

export interface StoredVerse {
  chapter: number;
  verse: number;
  text: string;
  textSha256: string;
}

/**
 * Every segment names a verse of this book, and the segments are consecutive verses in canon
 * order, crossing a chapter boundary only from a chapter's last verse to the next chapter's first.
 */
export function checkCoordinates(
  book: IndexBook | undefined,
  segments: readonly Pick<AnchorSegmentInput, 'chapter' | 'verse'>[],
): AnchorProblemCode | null {
  if (!book) return 'ANCHOR_VERSE_NOT_FOUND';
  for (const { chapter, verse } of segments) {
    const last = book.versesPerChapter[chapter - 1];
    if (last === undefined || verse > last) return 'ANCHOR_VERSE_NOT_FOUND';
  }
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (!prev || !cur) return 'ANCHOR_NOT_CONTIGUOUS';
    const lastOfPrev = book.versesPerChapter[prev.chapter - 1];
    const next =
      prev.verse === lastOfPrev
        ? { chapter: prev.chapter + 1, verse: 1 }
        : { chapter: prev.chapter, verse: prev.verse + 1 };
    if (cur.chapter !== next.chapter || cur.verse !== next.verse) return 'ANCHOR_NOT_CONTIGUOUS';
  }
  return null;
}

/**
 * The anchor against the stored text of its verses (`verses[i]` is segment i's verse). Checks, in
 * order: checksums (when the anchor carries them), offsets in range, the kind's shape, and the
 * quote equal to the stored slices joined by one space, code point for code point.
 */
export function checkText(
  anchor: AnchorInput,
  verses: readonly StoredVerse[],
): AnchorProblemCode | null {
  const { segments } = anchor;
  if (verses.length !== segments.length) return 'ANCHOR_VERSE_NOT_FOUND';
  const texts: string[][] = [];
  for (const [i, segment] of segments.entries()) {
    const stored = verses[i];
    if (!stored || stored.chapter !== segment.chapter || stored.verse !== segment.verse) {
      return 'ANCHOR_VERSE_NOT_FOUND';
    }
    if (segment.textSha256 !== undefined && segment.textSha256 !== stored.textSha256) {
      return 'ANCHOR_CHECKSUM_MISMATCH';
    }
    texts.push(Array.from(stored.text));
  }

  for (const [i, { start, end }] of segments.entries()) {
    if (start > end || end > (texts[i]?.length ?? 0)) return 'ANCHOR_OFFSET_OUT_OF_RANGE';
  }

  const whole = (i: number) => segments[i]?.start === 0 && segments[i]?.end === texts[i]?.length;
  const last = segments.length - 1;
  if (anchor.kind === 'verses') {
    if (!segments.every((_, i) => whole(i))) return 'ANCHOR_KIND_MISMATCH';
  } else {
    // Contiguous text: no gap between one verse's selected text and the next.
    for (let i = 0; i <= last; i += 1) {
      const s = segments[i];
      if (!s) return 'ANCHOR_NOT_CONTIGUOUS';
      if (i > 0 && s.start !== 0) return 'ANCHOR_NOT_CONTIGUOUS';
      if (i < last && s.end !== texts[i]?.length) return 'ANCHOR_NOT_CONTIGUOUS';
    }
    const first = segments[0];
    const final = segments[last];
    if (!first || !final || first.start === first.end || final.start === final.end) {
      return 'ANCHOR_EMPTY';
    }
  }

  const slices = segments.map(({ start, end }, i) => (texts[i] ?? []).slice(start, end).join(''));
  if (joinAnchorQuote(slices) !== anchor.quote) return 'ANCHOR_QUOTE_MISMATCH';
  return null;
}
