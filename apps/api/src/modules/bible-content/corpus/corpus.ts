import { createHash } from 'node:crypto';
import { parseUsfmBook, type UsfmBook, usfmBookCode } from './usfm';
import { readZip } from './zip';

/**
 * A pinned corpus release: where the artifact came from, what it must hash to, and the structure
 * and checksums its parse must produce. Every expected value is derived by parsing the committed
 * artifact (see `engwebp-release.ts`), never typed from memory.
 */
export interface CorpusRelease {
  code: string;
  name: string;
  abbreviation: string;
  language: string;
  canon: 'protestant';
  sourceUrl: string;
  /** Publisher's generation date of the artifact (`YYYY-MM-DD`). */
  sourceRelease: string;
  /** Path of the committed artifact, relative to `apps/api/corpus`. */
  artifactPath: string;
  artifactSha256: string;
  /** SHA-256 of the canonical serialization of every verse (see `contentSha256`). */
  contentSha256: string;
  /** Canon books in order, with their chapter counts. */
  books: readonly { code: string; chapters: number }[];
  /** Book codes present in the artifact that are not Scripture (front matter, glossary). */
  ignoredBooks: readonly string[];
  chapterCount: number;
  verseCount: number;
  /** Verses the edition numbers but whose text the publisher gives only in a footnote. */
  emptyVerses: readonly VerseKey[];
  /** Spot checks: SHA-256 of specific verses' text. */
  sampleVerses: readonly (VerseKey & { textSha256: string })[];
  licenseStatus: 'public_domain';
  attribution: string;
  rightsRecord: Record<string, unknown>;
}

export interface VerseKey {
  book: string;
  chapter: number;
  verse: number;
}

export interface CorpusBook {
  code: string;
  sequence: number;
  name: string;
  abbreviation: string;
  chapterCount: number;
}

export interface CorpusVerse {
  bookCode: string;
  chapter: number;
  verse: number;
  text: string;
  textSha256: string;
}

export interface ParsedCorpus {
  books: CorpusBook[];
  /** In canon order: book sequence, chapter, verse. */
  verses: CorpusVerse[];
}

/**
 * A corpus check failed. `code` is a fixed identifier that is safe to log (the process-failure
 * line carries it); the message may name a book or verse and is never logged.
 */
export class CorpusValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The edition checksum: SHA-256 of the UTF-8 concatenation, in canon order, of
 * `book \t chapter \t verse \t text \n` for every verse. The migration's
 * `bible_edition_content_sha256()` computes the same value in SQL from the stored rows.
 */
export function contentSha256(verses: readonly CorpusVerse[]): string {
  const hash = createHash('sha256');
  for (const v of verses) hash.update(`${v.bookCode}\t${v.chapter}\t${v.verse}\t${v.text}\n`);
  return hash.digest('hex');
}

/**
 * Unzips the artifact and parses every canon book's USFM. Books come out in the release's canon
 * order; any book the release neither lists nor ignores (a deuterocanonical book, say) fails.
 * Checks structure only as far as parsing needs; `validateCorpus` does the rest.
 */
export function parseArtifact(archive: Buffer, release: CorpusRelease): ParsedCorpus {
  const parsed = new Map<string, UsfmBook>();
  for (const [member, data] of readZip(archive)) {
    if (!member.endsWith('.usfm')) continue;
    const source = data.toString('utf8');
    if (release.ignoredBooks.includes(usfmBookCode(source))) continue;
    const book = parseUsfmBook(source);
    if (parsed.has(book.code)) throw new CorpusValidationError('CORPUS_BOOKS', 'duplicate book');
    parsed.set(book.code, book);
  }

  const sequence = new Map(release.books.map((b, i) => [b.code, i + 1]));
  const books = [...parsed.values()].sort(
    (a, b) => (sequence.get(a.code) ?? Infinity) - (sequence.get(b.code) ?? Infinity),
  );
  return {
    books: books.map((book, i) => ({
      code: book.code,
      sequence: i + 1,
      name: book.name,
      abbreviation: book.abbreviation,
      chapterCount: new Set(book.verses.map((v) => v.chapter)).size,
    })),
    verses: books.flatMap((book) =>
      book.verses.map((v) => ({
        bookCode: book.code,
        chapter: v.chapter,
        verse: v.verse,
        text: v.text,
        textSha256: sha256Hex(v.text),
      })),
    ),
  };
}

const keyOf = (book: string, chapter: number, verse: number): string =>
  `${book} ${chapter}:${verse}`;

/** Control characters (C0, DEL, C1), the replacement character, or leftover USFM syntax. */
function hasForbiddenCharacter(text: string): boolean {
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0xfffd) return true;
    if (character === '\\' || character === '|') return true;
  }
  return false;
}

/**
 * Every check PRD §20 asks for before a release may be activated: canon book set and order,
 * chapter and verse boundaries (contiguous from 1, per-book chapter counts, totals), empty verses,
 * Unicode, sample passages, per-verse checksums, and the edition checksum. Throws the first
 * failure as a `CorpusValidationError`.
 */
export function validateCorpus(corpus: ParsedCorpus, release: CorpusRelease): void {
  const fail = (code: string, message: string): never => {
    throw new CorpusValidationError(code, message);
  };

  const codes = corpus.books.map((b) => b.code);
  const expectedCodes = release.books.map((b) => b.code);
  if (codes.join(' ') !== expectedCodes.join(' ')) {
    fail('CORPUS_BOOKS', 'book set or order differs from the release');
  }
  corpus.books.forEach((book, i) => {
    if (book.sequence !== i + 1) fail('CORPUS_BOOKS', `${book.code} sequence`);
    if (book.chapterCount !== release.books[i]?.chapters) {
      fail('CORPUS_CHAPTER_COUNT', `${book.code} chapter count`);
    }
  });

  // Boundaries: in canon order, every verse is the next verse of its chapter, verse 1 of the next
  // chapter, or 1:1 of the next book. So chapters and verses are contiguous from 1, with no gaps,
  // duplicates, or out-of-order rows.
  let bookIndex = -1;
  let chapter = 0;
  let verse = 0;
  let chapters = 0;
  for (const v of corpus.verses) {
    if (v.bookCode === codes[bookIndex] && v.chapter === chapter && v.verse === verse + 1) {
      verse++;
    } else if (v.bookCode === codes[bookIndex] && v.chapter === chapter + 1 && v.verse === 1) {
      chapter++;
      verse = 1;
      chapters++;
    } else if (v.bookCode === codes[bookIndex + 1] && v.chapter === 1 && v.verse === 1) {
      bookIndex++;
      chapter = 1;
      verse = 1;
      chapters++;
    } else {
      fail('CORPUS_BOUNDARIES', `${keyOf(v.bookCode, v.chapter, v.verse)} out of sequence`);
    }
  }
  if (bookIndex !== codes.length - 1) fail('CORPUS_BOUNDARIES', 'a book has no verses');
  if (chapters !== release.chapterCount) fail('CORPUS_CHAPTER_COUNT', 'total chapters');
  if (corpus.verses.length !== release.verseCount) fail('CORPUS_VERSE_COUNT', 'total verses');

  const expectedEmpty = new Set(release.emptyVerses.map((k) => keyOf(k.book, k.chapter, k.verse)));
  for (const v of corpus.verses) {
    const key = keyOf(v.bookCode, v.chapter, v.verse);
    if ((v.text === '') !== expectedEmpty.has(key)) fail('CORPUS_EMPTY_VERSE', key);
    if (
      v.text !== v.text.normalize('NFC') ||
      hasForbiddenCharacter(v.text) ||
      v.text !== v.text.replace(/^ | $/g, '') ||
      v.text.includes('  ')
    ) {
      fail('CORPUS_UNICODE', key);
    }
    if (v.textSha256 !== sha256Hex(v.text)) fail('CORPUS_VERSE_CHECKSUM', key);
  }

  const byKey = new Map(corpus.verses.map((v) => [keyOf(v.bookCode, v.chapter, v.verse), v]));
  for (const sample of release.sampleVerses) {
    const key = keyOf(sample.book, sample.chapter, sample.verse);
    if (byKey.get(key)?.textSha256 !== sample.textSha256) fail('CORPUS_SAMPLE', key);
  }

  if (contentSha256(corpus.verses) !== release.contentSha256) {
    fail('CORPUS_CONTENT_CHECKSUM', 'edition checksum differs from the release');
  }
}
