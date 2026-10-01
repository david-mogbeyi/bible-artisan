import type { BiblePassageResponse, BibleTranslation } from '@bible-artisan/contracts';

/**
 * Test fixtures for the reader. The text is obviously synthetic: tests never type Scripture
 * (AGENTS.md rule 8); the API integration suite checks the real corpus byte for byte.
 */
export const EDITION_ID = '6f1c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60';
export const OTHER_EDITION_ID = '7a2d1b9f-6e8c-4d2f-8b4a-3a8f2d0e5c71';

export const TRANSLATION: BibleTranslation = {
  id: EDITION_ID,
  code: 'engwebp',
  name: 'World English Bible',
  abbreviation: 'WEBP',
  language: 'en',
  attribution: 'Attribution line from the rights record.',
  noticeUrl: 'https://example.test/about',
  books: [
    { code: 'GEN', name: 'Genesis', chapterCount: 50 },
    { code: 'PSA', name: 'Psalms', chapterCount: 150 },
    { code: 'ACT', name: 'Acts', chapterCount: 28 },
    { code: 'JUD', name: 'Jude', chapterCount: 1 },
    { code: 'REV', name: 'Revelation', chapterCount: 22 },
  ],
};

export const OTHER_TRANSLATION: BibleTranslation = {
  ...TRANSLATION,
  id: OTHER_EDITION_ID,
  code: 'other',
  name: 'Other Edition',
  abbreviation: 'OTH',
};

export const REFERENCE_ID = '11111111-2222-4333-8444-555555555555';

/** A reference to a whole three-verse chapter (marks nothing). */
export function wholeChapterReference(bookCode: string, chapter: number, bookName: string) {
  return {
    id: REFERENCE_ID,
    editionId: EDITION_ID,
    bookCode,
    startChapter: chapter,
    startVerse: 1,
    endChapter: chapter,
    endVerse: 3,
    label: `${bookName} ${chapter}`,
  };
}

export function chapter(
  overrides: Partial<BiblePassageResponse> & Pick<BiblePassageResponse, 'book' | 'chapter'>,
): BiblePassageResponse {
  return {
    edition: {
      id: EDITION_ID,
      name: TRANSLATION.name,
      abbreviation: TRANSLATION.abbreviation,
      attribution: TRANSLATION.attribution,
      noticeUrl: TRANSLATION.noticeUrl,
    },
    verses: [
      { verse: 1, text: 'Placeholder text one.' },
      { verse: 2, text: 'Placeholder text two.' },
      { verse: 3, text: 'Placeholder text three.' },
    ],
    superscriptions: [],
    reference: wholeChapterReference(overrides.book.code, overrides.chapter, overrides.book.name),
    previous: null,
    next: null,
    ...overrides,
  };
}

export const PSALM_2_ID = '22222222-2222-4333-8444-555555555555';
export const PSALM_3_ID = '33333333-2222-4333-8444-555555555555';
export const PSALM_4_ID = '44444444-2222-4333-8444-555555555555';
export const PSALM_5_ID = '55555555-3333-4333-8444-555555555555';

const psalmLink = (chapterNumber: number, referenceId: string) => ({
  bookCode: 'PSA',
  bookName: 'Psalms',
  chapter: chapterNumber,
  referenceId,
});

export const PSALM_3 = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 3,
  superscriptions: [{ beforeVerse: 1, text: 'Placeholder superscription.' }],
  reference: { ...wholeChapterReference('PSA', 3, 'Psalms'), id: PSALM_3_ID },
  previous: psalmLink(2, PSALM_2_ID),
  next: psalmLink(4, PSALM_4_ID),
});

export const PSALM_4 = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 4,
  verses: [{ verse: 1, text: 'Placeholder text of the next chapter.' }],
  reference: { ...wholeChapterReference('PSA', 4, 'Psalms'), id: PSALM_4_ID, endVerse: 1 },
  previous: psalmLink(3, PSALM_3_ID),
  next: psalmLink(5, PSALM_5_ID),
});

/** Psalm 3 as the other edition prints it (same synthetic text, the other attribution). */
export const OTHER_PSALM_3_ID = '66666666-2222-4333-8444-555555555555';

export const OTHER_PSALM_3 = chapter({
  ...PSALM_3,
  reference: { ...PSALM_3.reference, id: OTHER_PSALM_3_ID, editionId: OTHER_EDITION_ID },
  edition: {
    id: OTHER_EDITION_ID,
    name: OTHER_TRANSLATION.name,
    abbreviation: OTHER_TRANSLATION.abbreviation,
    attribution: 'Other attribution line.',
    noticeUrl: null,
  },
});

/** A promise the test settles by hand, to put responses out of order. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
