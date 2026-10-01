import { beforeAll, describe, expect, it } from 'vitest';
import { parseArtifact } from '../corpus/corpus';
import { readCorpusArtifact } from '../corpus/corpus-importer';
import { ENGWEBP_RELEASE } from '../corpus/engwebp-release';
import {
  BookIndex,
  EXPLICIT_BOOK_ALIASES,
  type IndexBook,
  type Resolution,
  resolveParsedReference,
} from './book-index';
import { parseReference } from './parse-reference';

/**
 * Exercises book matching and validation against the REAL corpus, parsed from the committed
 * publisher artifact (the same bytes `corpus:import` loads). Book names, chapter counts and
 * verse counts come from that data, never typed here; expected verse bounds are read from it.
 */
describe('resolveParsedReference against the WEB corpus', () => {
  let books: IndexBook[];
  let index: BookIndex;
  const book = (code: string): IndexBook => {
    const found = books.find((b) => b.code === code);
    if (!found) throw new Error(`no ${code}`);
    return found;
  };
  const resolve = (input: string): Resolution =>
    resolveParsedReference(index, parseReference(input));
  const resolved = (
    bookCode: string,
    startChapter: number,
    startVerse: number,
    endChapter: number,
    endVerse: number,
    label: string,
  ): Resolution => ({
    outcome: 'resolved',
    range: { bookCode, startChapter, startVerse, endChapter, endVerse },
    label,
  });
  const lastVerse = (code: string, chapter: number): number =>
    book(code).versesPerChapter[chapter - 1] ?? 0;

  beforeAll(() => {
    const corpus = parseArtifact(readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
    const counts = new Map<string, number[]>();
    for (const verse of corpus.verses) {
      const list = counts.get(verse.bookCode) ?? [];
      list[verse.chapter - 1] = Math.max(list[verse.chapter - 1] ?? 0, verse.verse);
      counts.set(verse.bookCode, list);
    }
    books = corpus.books.map((b) => ({ ...b, versesPerChapter: counts.get(b.code) ?? [] }));
    index = new BookIndex(books);
  });

  it('resolves Romans 9:1 and Rom 9:1 to the same canonical range (FR-BIBLE-001)', () => {
    expect(resolve('Romans 9:1')).toStrictEqual(resolved('ROM', 9, 1, 9, 1, 'Romans 9:1'));
    expect(resolve('Rom 9:1')).toStrictEqual(resolve('Romans 9:1'));
    expect(resolve('ROM 9:1')).toStrictEqual(resolve('Romans 9:1'));
    expect(resolve('rom. 9:1')).toStrictEqual(resolve('Romans 9:1'));
  });

  it('expands a whole chapter from the stored boundaries, equal to its full verse span', () => {
    const last = lastVerse('ROM', 9);
    expect(resolve('Romans 9')).toStrictEqual(resolved('ROM', 9, 1, 9, last, 'Romans 9'));
    expect(resolve(`Rom 9:1-${last}`)).toStrictEqual(resolve('Romans 9'));
  });

  it('opens chapter one for a book-only request', () => {
    expect(resolve('Romans')).toStrictEqual(
      resolved('ROM', 1, 1, 1, lastVerse('ROM', 1), 'Romans 1'),
    );
  });

  it('resolves within-chapter, cross-chapter and chapter ranges', () => {
    expect(resolve('Rom 9:1-5')).toStrictEqual(resolved('ROM', 9, 1, 9, 5, 'Romans 9:1–5'));
    expect(resolve('Rom 8:38-9:5')).toStrictEqual(resolved('ROM', 8, 38, 9, 5, 'Romans 8:38–9:5'));
    expect(resolve('Rom 9-10')).toStrictEqual(
      resolved('ROM', 9, 1, 10, lastVerse('ROM', 10), 'Romans 9–10'),
    );
  });

  it('applies the single-chapter convention: a bare number is a verse', () => {
    expect(resolve('Jude 3')).toStrictEqual(resolved('JUD', 1, 3, 1, 3, 'Jude 1:3'));
    expect(resolve('Jude 1:3')).toStrictEqual(resolve('Jude 3'));
    expect(resolve('Jude 3-5')).toStrictEqual(resolved('JUD', 1, 3, 1, 5, 'Jude 1:3–5'));
    expect(resolve('Jude 1')).toStrictEqual(resolved('JUD', 1, 1, 1, 1, 'Jude 1:1'));
    expect(resolve('Philemon 1')).toStrictEqual(resolved('PHM', 1, 1, 1, 1, 'Philemon 1:1'));
    expect(resolve('Jude')).toStrictEqual(resolved('JUD', 1, 1, 1, lastVerse('JUD', 1), 'Jude'));
    expect(resolve('Jude 2:1')).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_CHAPTER_OUT_OF_RANGE',
    });
    expect(resolve(`Jude ${lastVerse('JUD', 1) + 1}`)).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_VERSE_OUT_OF_RANGE',
    });
  });

  it('treats exactly the corpus books with one chapter as single-chapter books', () => {
    const single = books.filter((b) => b.chapterCount === 1).map((b) => b.code);
    expect(single).toStrictEqual(['OBA', 'PHM', '2JN', '3JN', 'JUD']);
    for (const code of single) {
      expect(resolve(`${book(code).name} 2`)).toStrictEqual(
        resolved(code, 1, 2, 1, 2, `${book(code).name} 1:2`),
      );
    }
  });

  it('never repairs an out-of-range reference to a nearby one (FR-BIBLE-002)', () => {
    const chapters = book('ROM').chapterCount;
    const last = lastVerse('ROM', 9);
    const invalid = (code: string): Resolution => ({ outcome: 'invalid', code }) as Resolution;
    expect(resolve(`Rom ${chapters + 1}:1`)).toStrictEqual(
      invalid('REFERENCE_CHAPTER_OUT_OF_RANGE'),
    );
    expect(resolve(`Rom ${chapters + 1}`)).toStrictEqual(invalid('REFERENCE_CHAPTER_OUT_OF_RANGE'));
    expect(resolve(`Rom 9:1-${chapters + 1}:1`)).toStrictEqual(
      invalid('REFERENCE_CHAPTER_OUT_OF_RANGE'),
    );
    expect(resolve(`Rom 9:${last + 1}`)).toStrictEqual(invalid('REFERENCE_VERSE_OUT_OF_RANGE'));
    expect(resolve(`Rom 9:1-${last + 1}`)).toStrictEqual(invalid('REFERENCE_VERSE_OUT_OF_RANGE'));
    expect(resolve('Rom 9:5-1')).toStrictEqual(invalid('REFERENCE_RANGE_REVERSED'));
    expect(resolve('Rom 10:1-9:5')).toStrictEqual(invalid('REFERENCE_RANGE_REVERSED'));
    expect(resolve('Rom 10-9')).toStrictEqual(invalid('REFERENCE_RANGE_REVERSED'));
  });

  it('allows exactly 200 verses and refuses 201', () => {
    // Walk forward from Psalm 119:1 (the corpus's longest chapter) using the corpus's own verse
    // counts to find the 200th and 201st verses.
    const nth = (n: number): [number, number] => {
      let chapter = 119;
      let remaining = n;
      while (remaining > lastVerse('PSA', chapter)) remaining -= lastVerse('PSA', chapter++);
      return [chapter, remaining];
    };
    const [c200, v200] = nth(200);
    const [c201, v201] = nth(201);
    expect(resolve(`Ps 119:1-${c200}:${v200}`)).toMatchObject({ outcome: 'resolved' });
    expect(resolve(`Ps 119:1-${c201}:${v201}`)).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_RANGE_TOO_LONG',
    });
    expect(resolve('Ps 1-150')).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_RANGE_TOO_LONG',
    });
  });

  it('resolves the verses the edition stores with empty text, as coordinates', () => {
    for (const { book: code, chapter, verse } of ENGWEBP_RELEASE.emptyVerses) {
      expect(resolve(`${code} ${chapter}:${verse}`)).toMatchObject({
        outcome: 'resolved',
        range: { bookCode: code, startChapter: chapter, startVerse: verse },
      });
    }
  });

  it('resolves every book by its corpus name, abbreviation and code (only Jud is ambiguous)', () => {
    const ambiguous = new Set<string>();
    for (const b of books) {
      for (const key of [b.name, b.abbreviation, b.code]) {
        const result = resolve(`${key} 1:1`);
        if (result.outcome === 'ambiguous') {
          expect(result.candidates.map((c) => c.bookCode)).toContain(b.code);
          ambiguous.add(key);
        } else {
          expect(result).toMatchObject({ outcome: 'resolved', range: { bookCode: b.code } });
        }
      }
    }
    expect([...ambiguous]).toStrictEqual(['Jud', 'JUD']);
  });

  it('resolves every explicit alias to its book, unambiguously', () => {
    for (const [alias, code] of Object.entries(EXPLICIT_BOOK_ALIASES)) {
      expect(resolve(`${alias} 1:1`)).toMatchObject({
        outcome: 'resolved',
        range: { bookCode: code },
      });
    }
    expect(resolve('Song of Songs 2:1')).toMatchObject({ range: { bookCode: 'SNG' } });
  });

  it('resolves numeric book forms', () => {
    for (const input of ['1 Tim 2:5', '1Tim 2:5', '1 Timothy 2:5', 'I Timothy 2:5', '1Ti 2:5']) {
      expect(resolve(input)).toStrictEqual(resolved('1TI', 2, 5, 2, 5, '1 Timothy 2:5'));
    }
    expect(resolve('III John 2')).toStrictEqual(resolved('3JN', 1, 2, 1, 2, '3 John 1:2'));
    expect(resolve('1 Jn 1:1')).toMatchObject({ range: { bookCode: '1JN' } });
  });

  it('returns every matching book, in canon order, for an ambiguous name (FR-BIBLE-003)', () => {
    expect(resolve('Jud 3')).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [
        { bookCode: 'JDG', bookName: 'Judges', input: 'Judges 3' },
        { bookCode: 'JUD', bookName: 'Jude', input: 'Jude 3' },
      ],
    });
    expect(resolve('Jud')).toMatchObject({
      outcome: 'ambiguous',
      candidates: [{ input: 'Judges' }, { input: 'Jude' }],
    });
    expect(resolve('Phil 1:1')).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [
        { bookCode: 'PHP', bookName: 'Philippians', input: 'Philippians 1:1' },
        { bookCode: 'PHM', bookName: 'Philemon', input: 'Philemon 1:1' },
      ],
    });
    const jo = resolve('Jo 1');
    expect(jo.outcome === 'ambiguous' && jo.candidates.map((c) => c.bookCode)).toStrictEqual([
      'JOS',
      'JOB',
      'JOL',
      'JON',
      'JHN',
    ]);
  });

  it('resolves a unique name prefix only when a chapter follows', () => {
    expect(resolve('Ps 23')).toMatchObject({ outcome: 'resolved', range: { bookCode: 'PSA' } });
    expect(resolve('Ezek 37:1')).toMatchObject({ outcome: 'resolved', range: { bookCode: 'EZK' } });
    expect(resolve('so')).toStrictEqual({ outcome: 'not_reference' });
    expect(resolve('am')).toStrictEqual({ outcome: 'not_reference' });
    expect(resolve('G 1')).toStrictEqual({ outcome: 'not_reference' });
  });

  it('separates keywords, unknown books and malformed references', () => {
    expect(resolve('bearing witness')).toStrictEqual({ outcome: 'not_reference' });
    expect(resolve('love 1')).toStrictEqual({ outcome: 'not_reference' });
    expect(resolve('Hezekiah 3:16')).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_UNKNOWN_BOOK',
    });
    expect(resolve('Rom 9:1,3')).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_MULTIPLE_PASSAGES',
    });
    expect(resolve('Rom 16:27-1 Cor 1:1')).toStrictEqual({
      outcome: 'invalid',
      code: 'REFERENCE_MULTIPLE_PASSAGES',
    });
    for (const input of ['Rom 9:', 'Rom 9.1', 'Rom 0:1', 'Rom 9-10:5']) {
      expect(resolve(input)).toStrictEqual({ outcome: 'invalid', code: 'REFERENCE_MALFORMED' });
    }
  });

  it('round-trips every label: chapter 1, a verse, and a range of each book', () => {
    for (const b of books) {
      const end = Math.min(3, b.versesPerChapter[0] ?? 1);
      for (const input of [`${b.code} 1`, `${b.code} 1:1`, `${b.code} 1:1-${end}`]) {
        const first = resolve(input);
        if (first.outcome !== 'resolved') {
          // Only Jude's code is ambiguous; resolve it through its name instead.
          expect(b.code).toBe('JUD');
          continue;
        }
        expect(resolve(first.label)).toStrictEqual(first);
      }
    }
  });

  it('refuses to build when an explicit alias names a book the edition lacks', () => {
    expect(() => new BookIndex(books.filter((b) => b.code !== 'SNG'))).toThrow(
      'BookIndex: an explicit alias names a book not in this edition',
    );
  });
});
