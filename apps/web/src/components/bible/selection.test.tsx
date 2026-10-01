import type { BiblePassageResponse } from '@bible-artisan/contracts';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapter, OTHER_TRANSLATION, TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { BibleReader } from './bible-reader';
import {
  boundariesOf,
  codePointOffset,
  phraseFromRange,
  phraseFromWords,
  sameAnchorSelection,
  sameBoundaries,
  spanOfRanges,
  versesSelection,
  wordsOf,
} from './selection';

/**
 * DOM selection → code-point anchor, measured over the reader's real markup (rendered by
 * BibleReader), so verse numbers, checkboxes, headings and "no text" notes are really there.
 * Text is synthetic (AGENTS.md rule 8) but uses the corpus's awkward characters: U+00A0, curly
 * quotes, plus an astral character the corpus does not have, to pin UTF-16 vs code points.
 */
const MATH_A = '\u{1d400}'; // one code point, two UTF-16 units
const V1 = 'one two three';
const V2 = `a${MATH_A}b “quoted” end`;
const V4 = 'four five six';

const PASSAGE: BiblePassageResponse = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 3,
  verses: [
    { verse: 1, text: V1 },
    { verse: 2, text: V2 },
    { verse: 3, text: '' },
    { verse: 4, text: V4 },
  ],
  superscriptions: [{ beforeVerse: 1, text: 'Placeholder heading.' }],
  reference: {
    id: '33333333-2222-4333-8444-555555555555',
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    startChapter: 3,
    startVerse: 2,
    endChapter: 3,
    endVerse: 2,
    label: 'Psalms 3:2',
  },
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(200, PASSAGE))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPassage(): Promise<HTMLOListElement> {
  renderWithQuery(
    <BibleReader
      translations={[TRANSLATION, OTHER_TRANSLATION]}
      editionId={TRANSLATION.id}
      referenceId={PASSAGE.reference.id}
      onOpenChapter={vi.fn()}
      onOpenReference={vi.fn()}
      onChangeEdition={vi.fn()}
      focusRequest={null}
    />,
  );
  await screen.findByRole('heading', { name: 'Psalms 3' });
  return screen.getByRole<HTMLOListElement>('list');
}

const verseText = (list: Element, verse: number): Element => {
  const el = list.querySelector(`[data-verse-text="${verse}"]`);
  if (!el) throw new Error(`no verse ${verse}`);
  return el;
};
const textNode = (list: Element, verse: number): Text => {
  const node = verseText(list, verse).firstChild;
  if (!(node instanceof Text)) throw new Error(`verse ${verse} has no text node`);
  return node;
};
const numberOf = (list: Element, verse: number): Node => {
  const span = verseText(list, verse).previousElementSibling;
  if (!span) throw new Error('no verse number');
  return span;
};

function range(start: [Node, number], end: [Node, number]): Range {
  const r = document.createRange();
  r.setStart(...start);
  r.setEnd(...end);
  return r;
}

const seg = (verse: number, start: number, end: number) => ({ chapter: 3, verse, start, end });
const phrase = (segments: ReturnType<typeof seg>[], quote: string) => ({
  editionId: TRANSLATION.id,
  bookCode: 'PSA',
  kind: 'phrase',
  segments,
  quote,
});

describe('phraseFromRange over the reader markup', () => {
  it('maps a partial-word selection inside one verse', async () => {
    const list = await renderPassage();
    const t = textNode(list, 1);
    expect(phraseFromRange(range([t, 1], [t, 6]), list, PASSAGE)).toStrictEqual(
      phrase([seg(1, 1, 6)], 'ne tw'),
    );
  });

  it('starts at the verse text when the selection starts on a verse number, checkbox or heading', async () => {
    const list = await renderPassage();
    const t2 = textNode(list, 2);
    const expected = phrase([seg(1, 0, 13), seg(2, 0, 1)], `${V1} a`);
    expect(phraseFromRange(range([numberOf(list, 1), 0], [t2, 1]), list, PASSAGE)).toStrictEqual(
      expected,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select verse 1' });
    expect(
      phraseFromRange(range([checkbox.parentNode as Node, 0], [t2, 1]), list, PASSAGE),
    ).toStrictEqual(expected);
    const heading = screen.getByText('Placeholder heading.');
    expect(phraseFromRange(range([heading, 0], [t2, 1]), list, PASSAGE)).toStrictEqual(expected);
  });

  it('passes through a verse with no text, without its note, and drops it at either end', async () => {
    const list = await renderPassage();
    const t2 = textNode(list, 2);
    const t4 = textNode(list, 4);
    // UTF-16 offset 14 in V2 is code point 13 (the astral character counts once).
    expect(phraseFromRange(range([t2, 14], [t4, 4]), list, PASSAGE)).toStrictEqual(
      phrase([seg(2, 13, 16), seg(3, 0, 0), seg(4, 0, 4)], 'end four'),
    );
    // Ending on verse 4's number: the empty verse 3 is dropped from the end.
    expect(phraseFromRange(range([t2, 14], [numberOf(list, 4), 0]), list, PASSAGE)).toStrictEqual(
      phrase([seg(2, 13, 16)], 'end'),
    );
    // The "no text" note is not verse text: selecting only it selects nothing.
    const note = screen.getByText('No text for this verse in this edition.');
    expect(phraseFromRange(range([note, 0], [note, 1]), list, PASSAGE)).toBeNull();
  });

  it('counts code points, and never splits an astral character', async () => {
    const list = await renderPassage();
    const t = textNode(list, 2);
    // UTF-16 [1, 3) is the whole astral character: code points [1, 2).
    expect(phraseFromRange(range([t, 1], [t, 3]), list, PASSAGE)).toStrictEqual(
      phrase([seg(2, 1, 2)], MATH_A),
    );
    // Offsets inside the surrogate pair round outward to keep the whole character.
    expect(phraseFromRange(range([t, 2], [t, 2 + 2]), list, PASSAGE)).toStrictEqual(
      phrase([seg(2, 1, 3)], `${MATH_A}b`),
    );
  });

  it('keeps curly quotes and inner no-break spaces, trimming only spaces at the ends', async () => {
    const list = await renderPassage();
    const t1 = textNode(list, 1);
    const t2 = textNode(list, 2);
    // " “quoted” " with spaces on both sides (UTF-16 [4, 14)): trimmed to the quotes.
    expect(phraseFromRange(range([t2, 4], [t2, 14]), list, PASSAGE)).toStrictEqual(
      phrase([seg(2, 4, 12)], '“quoted”'),
    );
    // A no-break space at the edge is trimmed; inside, it is kept.
    expect(phraseFromRange(range([t1, 7], [t1, 13]), list, PASSAGE)).toStrictEqual(
      phrase([seg(1, 8, 13)], 'three'),
    );
    expect(phraseFromRange(range([t1, 4], [t1, 13]), list, PASSAGE)).toStrictEqual(
      phrase([seg(1, 4, 13)], 'two three'),
    );
    // Only spaces: nothing.
    expect(phraseFromRange(range([t1, 3], [t1, 4]), list, PASSAGE)).toBeNull();
  });

  it('measures through nested elements such as a highlight mark', async () => {
    const list = await renderPassage();
    const t4 = textNode(list, 4);
    const middle = t4.splitText(5); // "four " | "five six"
    middle.splitText(4); // "five" | " six"
    const mark = document.createElement('mark');
    middle.replaceWith(mark);
    mark.append(middle);
    expect(
      phraseFromRange(range([middle, 1], [mark.nextSibling as Node, 2]), list, PASSAGE),
    ).toStrictEqual(phrase([seg(4, 6, 11)], 'ive s'));
  });

  it('refuses rather than guesses when the markup text is not the stored text', async () => {
    const list = await renderPassage();
    const t = textNode(list, 1);
    t.data = `${V1}!`;
    expect(phraseFromRange(range([t, 0], [t, 3]), list, PASSAGE)).toBeNull();
  });

  it('returns null for a collapsed range or one that touches no verse text', async () => {
    const list = await renderPassage();
    const t = textNode(list, 1);
    expect(phraseFromRange(range([t, 2], [t, 2]), list, PASSAGE)).toBeNull();
    const heading = screen.getByText('Placeholder heading.');
    expect(phraseFromRange(range([heading, 0], [heading, 1]), list, PASSAGE)).toBeNull();
  });

  it('maps a backward (right-to-left) native selection the same as a forward one', async () => {
    const list = await renderPassage();
    const t = textNode(list, 4);
    const selection = document.getSelection();
    if (!selection) throw new Error('no selection API');
    selection.setBaseAndExtent(t, 9, t, 5);
    expect(selection.anchorOffset).toBe(9);
    expect(phraseFromRange(selection.getRangeAt(0), list, PASSAGE)).toStrictEqual(
      phrase([seg(4, 5, 9)], 'five'),
    );
    selection.removeAllRanges();
  });
});

describe('several ranges (Firefox splits a selection around user-select: none nodes)', () => {
  it('maps from the earliest start to the latest end, in any order', async () => {
    const list = await renderPassage();
    const t1 = textNode(list, 1);
    const t2 = textNode(list, 2);
    const t4 = textNode(list, 4);
    // Three pieces that skip verse 2's and verse 4's checkbox and number (and verse 3's note).
    const a = range([t1, 4], [t1, t1.length]);
    const b = range([t2, 0], [t2, t2.length]);
    const c = range([t4, 0], [t4, 4]);
    const expected = phrase(
      [seg(1, 4, 13), seg(2, 0, 16), seg(3, 0, 0), seg(4, 0, 4)],
      `${V1.slice(4)} ${V2} four`,
    );
    for (const order of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ]) {
      const span = spanOfRanges(order);
      if (!span) throw new Error('no span');
      expect(phraseFromRange(span, list, PASSAGE)).toStrictEqual(expected);
    }
    // The pieces themselves are untouched.
    expect([a.startOffset, c.endOffset]).toStrictEqual([4, 4]);
    expect(spanOfRanges([])).toBeNull();
    expect(phraseFromRange(spanOfRanges([c]) as Range, list, PASSAGE)).toStrictEqual(
      phrase([seg(4, 0, 4)], 'four'),
    );
  });

  it('compares boundary points by node identity and offset', async () => {
    const list = await renderPassage();
    const t1 = textNode(list, 1);
    const one = boundariesOf([range([t1, 0], [t1, 3])]);
    expect(sameBoundaries(one, boundariesOf([range([t1, 0], [t1, 3])]))).toBe(true);
    expect(sameBoundaries(one, boundariesOf([range([t1, 0], [t1, 4])]))).toBe(false);
    expect(sameBoundaries(one, boundariesOf([]))).toBe(false);
  });
});

describe('sameAnchorSelection', () => {
  it('compares every field without serializing', () => {
    const a = phrase([seg(1, 0, 3)], 'one') as Parameters<typeof sameAnchorSelection>[0];
    expect(sameAnchorSelection(a, { ...a, segments: [seg(1, 0, 3)] })).toBe(true);
    expect(sameAnchorSelection(a, { ...a, segments: [seg(1, 0, 4)] })).toBe(false);
    expect(sameAnchorSelection(a, { ...a, kind: 'verses' })).toBe(false);
    expect(sameAnchorSelection(a, { ...a, quote: 'one!' })).toBe(false);
    expect(sameAnchorSelection(a, { ...a, segments: [seg(1, 0, 3), seg(2, 0, 1)] })).toBe(false);
  });
});

describe('codePointOffset', () => {
  it('converts UTF-16 offsets and rounds a split surrogate pair outward', () => {
    expect(codePointOffset(V2, 0, 'floor')).toBe(0);
    expect(codePointOffset(V2, 3, 'floor')).toBe(2);
    expect(codePointOffset(V2, 2, 'floor')).toBe(1);
    expect(codePointOffset(V2, 2, 'ceil')).toBe(2);
    expect(codePointOffset(V2, V2.length, 'ceil')).toBe(Array.from(V2).length);
  });
});

describe('versesSelection', () => {
  it('builds whole verses, allows an empty verse, and refuses a gap', () => {
    expect(versesSelection(PASSAGE, [4, 3, 2])).toStrictEqual({
      editionId: TRANSLATION.id,
      bookCode: 'PSA',
      kind: 'verses',
      segments: [seg(2, 0, 16), seg(3, 0, 0), seg(4, 0, 13)],
      quote: `${V2} ${V4}`,
    });
    expect(versesSelection(PASSAGE, [1, 3])).toBe('not_contiguous');
    expect(versesSelection(PASSAGE, [])).toBeNull();
  });
});

describe('words and the keyboard phrase', () => {
  it('lists words verbatim with code-point offsets', () => {
    expect(wordsOf(V2)).toStrictEqual([
      { text: `a${MATH_A}b`, start: 0, end: 3 },
      { text: '“quoted”', start: 4, end: 12 },
      { text: 'end', start: 13, end: 16 },
    ]);
    expect(wordsOf(V1)).toStrictEqual([
      { text: 'one', start: 0, end: 3 },
      { text: 'two three', start: 4, end: 13 },
    ]);
    expect(wordsOf('')).toStrictEqual([]);
  });

  it('builds a phrase across verses from first and last word, and refuses a reversed one', () => {
    expect(phraseFromWords(PASSAGE, { verse: 2, word: 2 }, { verse: 4, word: 1 })).toStrictEqual(
      phrase([seg(2, 13, 16), seg(3, 0, 0), seg(4, 0, 9)], 'end four five'),
    );
    expect(phraseFromWords(PASSAGE, { verse: 4, word: 0 }, { verse: 2, word: 0 })).toBeNull();
    expect(phraseFromWords(PASSAGE, { verse: 4, word: 2 }, { verse: 4, word: 1 })).toBeNull();
    expect(phraseFromWords(PASSAGE, { verse: 3, word: 0 }, { verse: 4, word: 0 })).toBeNull();
  });
});
