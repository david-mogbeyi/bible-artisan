import {
  MAX_REFERENCE_VERSES,
  type ReferenceCandidate,
  type ReferenceErrorCode,
} from '@bible-artisan/contracts';
import { formatSpec, normalizeBookKey, type ParsedReference } from './parse-reference';

/**
 * Common English abbreviations that are not the edition's own `\toc2` name, `\toc3` abbreviation
 * or USFM code, keyed by normalized alias -> USFM book code. Data, not logic: every entry must
 * name a book in the edition (`BookIndex` refuses to build otherwise) and is tested to resolve
 * unambiguously against the real corpus. Keep this list short; never add an alias that is also
 * the start of another book's name (it would only ever be ambiguous).
 */
export const EXPLICIT_BOOK_ALIASES: Readonly<Record<string, string>> = {
  jn: 'JHN',
  mk: 'MRK',
  mt: 'MAT',
  lk: 'LUK',
  songofsongs: 'SNG',
};

/** One book of an edition, as read from the corpus tables. */
export interface IndexBook {
  code: string;
  sequence: number;
  /** The publisher's `\toc2` name, e.g. `1 Corinthians`. */
  name: string;
  /** The publisher's `\toc3` abbreviation, e.g. `1Co`. */
  abbreviation: string;
  chapterCount: number;
  /** Verse count of each chapter, chapter 1 first (verses are contiguous from 1, BIB-14). */
  versesPerChapter: readonly number[];
}

export interface ReferenceRange {
  bookCode: string;
  startChapter: number;
  startVerse: number;
  endChapter: number;
  endVerse: number;
}

export type Resolution =
  | { outcome: 'resolved'; range: ReferenceRange; label: string }
  | { outcome: 'ambiguous'; candidates: ReferenceCandidate[] }
  | { outcome: 'not_reference' }
  | { outcome: 'invalid'; code: ReferenceErrorCode };

/** Two or more letters (after a numeric prefix) may match the start of a book's name. */
const MIN_PREFIX_LETTERS = 2;

/**
 * Book lookup for one edition, built from that edition's corpus rows (never a typed table).
 * Exact keys are each book's normalized name, abbreviation and code, plus `EXPLICIT_BOOK_ALIASES`.
 */
export class BookIndex {
  private readonly books: readonly IndexBook[];
  private readonly exact = new Map<string, Set<IndexBook>>();
  private readonly nameKeys: readonly [string, IndexBook][];

  constructor(books: readonly IndexBook[]) {
    this.books = [...books].sort((a, b) => a.sequence - b.sequence);
    const byCode = new Map(this.books.map((book) => [book.code, book]));
    const add = (key: string, book: IndexBook): void => {
      const set = this.exact.get(key) ?? new Set<IndexBook>();
      set.add(book);
      this.exact.set(key, set);
    };
    for (const book of this.books) {
      if (book.versesPerChapter.length !== book.chapterCount) {
        throw new Error('BookIndex: chapter counts disagree with verse counts');
      }
      for (const key of [book.name, book.abbreviation, book.code]) add(normalizeBookKey(key), book);
    }
    for (const [alias, code] of Object.entries(EXPLICIT_BOOK_ALIASES)) {
      const book = byCode.get(code);
      if (!book) throw new Error('BookIndex: an explicit alias names a book not in this edition');
      add(alias, book);
    }
    this.nameKeys = this.books.map((book) => [normalizeBookKey(book.name), book]);
  }

  /**
   * Every book the token could mean, in canon order: exact key matches plus (for a token of at
   * least two letters) books whose normalized name starts with it. Book-only input never matches
   * by prefix alone, so keywords like "so" or "am" are not taken for Song of Solomon or Amos; but
   * an exact match there still reports every book it is a prefix of (`Jud` -> Judges and Jude).
   */
  /** The book with this USFM code, if the edition has it. */
  book(code: string): IndexBook | undefined {
    return this.books.find((book) => book.code === code);
  }

  candidates(key: string, letters: number, allowPrefixOnly: boolean): IndexBook[] {
    const found = new Set(this.exact.get(key) ?? []);
    if (letters >= MIN_PREFIX_LETTERS && (allowPrefixOnly || found.size > 0)) {
      for (const [nameKey, book] of this.nameKeys) if (nameKey.startsWith(key)) found.add(book);
    }
    return this.books.filter((book) => found.has(book));
  }
}

function invalid(code: ReferenceErrorCode): Resolution {
  return { outcome: 'invalid', code };
}

function verseCount(book: IndexBook, range: ReferenceRange): number {
  const { startChapter, startVerse, endChapter, endVerse } = range;
  if (startChapter === endChapter) return endVerse - startVerse + 1;
  let count = (book.versesPerChapter[startChapter - 1] ?? 0) - startVerse + 1 + endVerse;
  for (let chapter = startChapter + 1; chapter < endChapter; chapter++) {
    count += book.versesPerChapter[chapter - 1] ?? 0;
  }
  return count;
}

/**
 * The deterministic display label. Whole chapters show as `Romans 9` / `Romans 9–10`; a
 * single-chapter book always shows its chapter (`Jude 1:3`), and the whole book as `Jude`, so
 * every label resolves back to the same range.
 */
function referenceLabel(book: IndexBook, range: ReferenceRange): string {
  const { startChapter, startVerse, endChapter, endVerse } = range;
  const wholeChapters = startVerse === 1 && endVerse === book.versesPerChapter[endChapter - 1];
  if (book.chapterCount === 1) {
    if (wholeChapters) return book.name;
    return startVerse === endVerse
      ? `${book.name} 1:${startVerse}`
      : `${book.name} 1:${startVerse}–${endVerse}`;
  }
  if (wholeChapters) {
    return startChapter === endChapter
      ? `${book.name} ${startChapter}`
      : `${book.name} ${startChapter}–${endChapter}`;
  }
  if (startChapter === endChapter) {
    return startVerse === endVerse
      ? `${book.name} ${startChapter}:${startVerse}`
      : `${book.name} ${startChapter}:${startVerse}–${endVerse}`;
  }
  return `${book.name} ${startChapter}:${startVerse}–${endChapter}:${endVerse}`;
}

/**
 * Validates a parsed reference against one book of the edition. Never adjusts a number: a
 * chapter or verse the corpus does not have is an error, not the nearest one that exists.
 */
function rangeIn(
  book: IndexBook,
  spec: Extract<ParsedReference, { kind: 'reference' }>['spec'],
): Resolution {
  const last = (chapter: number): number => book.versesPerChapter[chapter - 1] ?? 0;
  const single = book.chapterCount === 1;
  // Chapters first (a verse bound needs a real chapter), then verses.
  let chapters: [number, number];
  switch (spec.form) {
    case 'book':
      chapters = [1, 1];
      break;
    case 'number':
      chapters = single ? [1, 1] : [spec.first, spec.first];
      break;
    case 'number-range':
      chapters = single ? [1, 1] : [spec.first, spec.last];
      break;
    case 'chapter-verse':
    case 'verse-range':
      chapters = [spec.chapter, spec.chapter];
      break;
    case 'chapter-verse-range':
      chapters = [spec.chapter, spec.endChapter];
      break;
  }
  if (chapters.some((chapter) => chapter > book.chapterCount)) {
    return invalid('REFERENCE_CHAPTER_OUT_OF_RANGE');
  }
  const [startChapter, endChapter] = chapters;

  let verses: [number, number];
  switch (spec.form) {
    case 'book':
      verses = [1, last(1)];
      break;
    case 'number':
      verses = single ? [spec.first, spec.first] : [1, last(endChapter)];
      break;
    case 'number-range':
      verses = single ? [spec.first, spec.last] : [1, last(endChapter)];
      break;
    case 'chapter-verse':
      verses = [spec.verse, spec.verse];
      break;
    case 'verse-range':
      verses = [spec.verse, spec.endVerse];
      break;
    case 'chapter-verse-range':
      verses = [spec.verse, spec.endVerse];
      break;
  }
  const [startVerse, endVerse] = verses;
  if (startVerse > last(startChapter) || endVerse > last(endChapter)) {
    return invalid('REFERENCE_VERSE_OUT_OF_RANGE');
  }

  const range: ReferenceRange = {
    bookCode: book.code,
    startChapter,
    startVerse,
    endChapter,
    endVerse,
  };
  if (startChapter > endChapter || (startChapter === endChapter && startVerse > endVerse)) {
    return invalid('REFERENCE_RANGE_REVERSED');
  }
  if (verseCount(book, range) > MAX_REFERENCE_VERSES) return invalid('REFERENCE_RANGE_TOO_LONG');
  return { outcome: 'resolved', range, label: referenceLabel(book, range) };
}

/**
 * Matches a parsed reference to the edition's books and validates it (BIB-15):
 * - no book: a clear reference shape (it had `:`) is `REFERENCE_UNKNOWN_BOOK`, anything else is
 *   `not_reference` so the caller can search for it as keywords;
 * - malformed (a book followed by digits, but not a complete reference): 422, never a guess;
 * - more than one book: the candidates whose numbers exist in that book (each validated as if
 *   it had been typed with that book's name), never a silent pick. The user typed an ambiguous
 *   key, so even when only one candidate remains valid it is still offered as `ambiguous` with
 *   that single candidate, never resolved (`Phil 4:1` offers Philippians only: Philemon has one
 *   chapter). When none is valid, the first candidate's (canon order) 422 code is returned, so
 *   the result is deterministic and never points at a range that does not exist;
 * - one book: the validated range, or a specific 422 code.
 */
export function resolveParsedReference(index: BookIndex, parsed: ParsedReference): Resolution {
  if (parsed.kind === 'not_reference') return { outcome: 'not_reference' };
  const bookOnly = parsed.kind === 'reference' && parsed.spec.form === 'book';
  const books = index.candidates(parsed.key, parsed.letters, !bookOnly);
  if (books.length === 0) {
    return parsed.hasColon ? invalid('REFERENCE_UNKNOWN_BOOK') : { outcome: 'not_reference' };
  }
  if (parsed.kind === 'malformed') {
    return invalid(parsed.multiple ? 'REFERENCE_MULTIPLE_PASSAGES' : 'REFERENCE_MALFORMED');
  }
  const [book] = books;
  if (!book) return { outcome: 'not_reference' };
  if (books.length === 1) return rangeIn(book, parsed.spec);

  const checked = books.map((candidate) => ({
    candidate,
    result: rangeIn(candidate, parsed.spec),
  }));
  const valid = checked.filter(({ result }) => result.outcome === 'resolved');
  const [first] = checked;
  if (valid.length === 0) return first ? first.result : { outcome: 'not_reference' };
  const tail = formatSpec(parsed.spec);
  return {
    outcome: 'ambiguous',
    candidates: valid.map(({ candidate }) => ({
      bookCode: candidate.code,
      bookName: candidate.name,
      input: tail ? `${candidate.name} ${tail}` : candidate.name,
    })),
  };
}
