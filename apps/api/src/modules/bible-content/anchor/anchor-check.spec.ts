import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexBook } from '../reference/book-index';
import { type AnchorInput, checkCoordinates, checkText, type StoredVerse } from './anchor-check';

/**
 * Synthetic text only (AGENTS.md rule 8): the rules are about code points, not about Scripture.
 * The integration suite checks the same rules against the real corpus.
 */
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const verse = (chapter: number, n: number, text: string): StoredVerse => ({
  chapter,
  verse: n,
  text,
  textSha256: sha(text),
});

const BOOK: IndexBook = {
  code: 'TST',
  sequence: 1,
  name: 'Test',
  abbreviation: 'Tst',
  chapterCount: 2,
  versesPerChapter: [3, 2],
};

const ASTRAL = 'a\u{1d400}b'; // 3 code points, 4 UTF-16 units
const NBSP = 'one two “three”';

describe('checkCoordinates', () => {
  const seg = (chapter: number, n: number) => ({ chapter, verse: n, start: 0, end: 0 });

  it('accepts consecutive verses, including across a chapter boundary', () => {
    expect(checkCoordinates(BOOK, [seg(1, 2), seg(1, 3), seg(2, 1)])).toBeNull();
    expect(checkCoordinates(BOOK, [seg(2, 2)])).toBeNull();
  });

  it('refuses a verse, chapter or book the edition lacks', () => {
    expect(checkCoordinates(BOOK, [seg(1, 4)])).toBe('ANCHOR_VERSE_NOT_FOUND');
    expect(checkCoordinates(BOOK, [seg(3, 1)])).toBe('ANCHOR_VERSE_NOT_FOUND');
    expect(checkCoordinates(undefined, [seg(1, 1)])).toBe('ANCHOR_VERSE_NOT_FOUND');
  });

  it('refuses gaps, repeats, reversed order and a chapter jump that skips verses', () => {
    for (const segments of [
      [seg(1, 1), seg(1, 3)],
      [seg(1, 1), seg(1, 1)],
      [seg(1, 2), seg(1, 1)],
      [seg(1, 2), seg(2, 1)],
      [seg(1, 3), seg(2, 2)],
    ]) {
      expect(checkCoordinates(BOOK, segments)).toBe('ANCHOR_NOT_CONTIGUOUS');
    }
  });
});

describe('checkText', () => {
  const v1 = verse(1, 1, ASTRAL);
  const v2 = verse(1, 2, NBSP);
  const v3 = verse(1, 3, '');

  const phrase = (segments: AnchorInput['segments'], quote: string): AnchorInput => ({
    kind: 'phrase',
    segments,
    quote,
  });

  it('measures offsets in code points, not UTF-16 units', () => {
    expect(checkText(phrase([{ chapter: 1, verse: 1, start: 1, end: 2 }], '\u{1d400}'), [v1])).toBe(
      null,
    );
    expect(checkText(phrase([{ chapter: 1, verse: 1, start: 0, end: 3 }], ASTRAL), [v1])).toBe(
      null,
    );
    // Offset 4 exists in UTF-16 but not in code points.
    expect(checkText(phrase([{ chapter: 1, verse: 1, start: 0, end: 4 }], ASTRAL), [v1])).toBe(
      'ANCHOR_OFFSET_OUT_OF_RANGE',
    );
  });

  it('keeps no-break spaces and curly quotes exactly, with no folding', () => {
    const seg = { chapter: 1, verse: 2, start: 0, end: 7 };
    expect(checkText(phrase([seg], 'one two'), [v2])).toBeNull();
    expect(checkText(phrase([seg], 'one two'), [v2])).toBe('ANCHOR_QUOTE_MISMATCH');
    const quoted = { chapter: 1, verse: 2, start: 8, end: 15 };
    expect(checkText(phrase([quoted], '“three”'), [v2])).toBeNull();
    expect(checkText(phrase([quoted], '"three"'), [v2])).toBe('ANCHOR_QUOTE_MISMATCH');
  });

  it('joins a cross-verse phrase with one space and requires contiguous text', () => {
    const tail = { chapter: 1, verse: 1, start: 2, end: 3 };
    const head = { chapter: 1, verse: 2, start: 0, end: 3 };
    expect(checkText(phrase([tail, head], 'b one'), [v1, v2])).toBeNull();
    expect(checkText(phrase([tail, head], 'bone'), [v1, v2])).toBe('ANCHOR_QUOTE_MISMATCH');
    // A gap at the end of the first verse or the start of the last.
    expect(checkText(phrase([{ ...tail, end: 2 }, head], 'a one'), [v1, v2])).toBe(
      'ANCHOR_NOT_CONTIGUOUS',
    );
    expect(checkText(phrase([tail, { ...head, start: 1 }], 'b ne'), [v1, v2])).toBe(
      'ANCHOR_NOT_CONTIGUOUS',
    );
  });

  it('allows an empty verse inside a phrase but not at either end', () => {
    const v4 = verse(1, 4, 'four');
    const tail = { chapter: 1, verse: 2, start: 14, end: 15 };
    const empty = { chapter: 1, verse: 3, start: 0, end: 0 };
    const head = { chapter: 1, verse: 4, start: 0, end: 2 };
    expect(checkText(phrase([tail, empty, head], '” fo'), [v2, v3, v4])).toBeNull();
    expect(checkText(phrase([empty, head], 'fo'), [v3, v4])).toBe('ANCHOR_EMPTY');
    expect(checkText(phrase([{ ...tail, start: 15 }, empty], ''), [v2, v3])).toBe('ANCHOR_EMPTY');
    expect(checkText(phrase([{ chapter: 1, verse: 1, start: 1, end: 1 }], ''), [v1])).toBe(
      'ANCHOR_EMPTY',
    );
  });

  it('requires whole verses for kind verses, and allows an empty verse there', () => {
    const whole = (s: StoredVerse) => ({
      chapter: s.chapter,
      verse: s.verse,
      start: 0,
      end: Array.from(s.text).length,
    });
    const verses = (segments: AnchorInput['segments'], quote: string): AnchorInput => ({
      kind: 'verses',
      segments,
      quote,
    });
    expect(checkText(verses([whole(v2), whole(v3)], NBSP), [v2, v3])).toBeNull();
    expect(checkText(verses([whole(v3)], ''), [v3])).toBeNull();
    expect(checkText(verses([{ ...whole(v2), start: 1 }], NBSP.slice(1)), [v2])).toBe(
      'ANCHOR_KIND_MISMATCH',
    );
  });

  it('reports a checksum mismatch before anything else, and checks only when one is given', () => {
    const seg = { chapter: 1, verse: 1, start: 0, end: 3 };
    expect(checkText(phrase([{ ...seg, textSha256: v1.textSha256 }], ASTRAL), [v1])).toBeNull();
    expect(checkText(phrase([{ ...seg, end: 99, textSha256: sha('other') }], 'x'), [v1])).toBe(
      'ANCHOR_CHECKSUM_MISMATCH',
    );
  });

  it('refuses verses that do not line up with the segments', () => {
    const seg = { chapter: 1, verse: 1, start: 0, end: 3 };
    expect(checkText(phrase([seg], ASTRAL), [v2])).toBe('ANCHOR_VERSE_NOT_FOUND');
    expect(checkText(phrase([seg], ASTRAL), [])).toBe('ANCHOR_VERSE_NOT_FOUND');
  });
});
