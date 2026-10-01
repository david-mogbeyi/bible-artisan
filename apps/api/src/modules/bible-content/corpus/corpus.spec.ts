import { beforeAll, describe, expect, it } from 'vitest';
import { failureFields } from '../../observability/entrypoint';
import {
  contentSha256,
  CorpusValidationError,
  type ParsedCorpus,
  parseArtifact,
  sha256Hex,
  validateCorpus,
} from './corpus';
import { readCorpusArtifact } from './corpus-importer';
import { ENGWEBP_RELEASE } from './engwebp-release';
import { readZip } from './zip';

/*
 * The real artifact, parsed once. Failure cases mutate a deep copy structurally (drop, reorder,
 * blank, or append placeholder characters to verses); no Scripture text is typed here.
 */
let corpus: ParsedCorpus;

beforeAll(() => {
  corpus = parseArtifact(readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
});

function mutated(change: (copy: ParsedCorpus) => void): ParsedCorpus {
  const copy = structuredClone(corpus);
  change(copy);
  return copy;
}

function failureCode(candidate: ParsedCorpus, release = ENGWEBP_RELEASE): string | undefined {
  try {
    validateCorpus(candidate, release);
    return undefined;
  } catch (error) {
    if (error instanceof CorpusValidationError) return error.code;
    throw error;
  }
}

describe('the pinned engwebp release', () => {
  it('matches the committed artifact', () => {
    expect(sha256Hex(readCorpusArtifact(ENGWEBP_RELEASE))).toBe(ENGWEBP_RELEASE.artifactSha256);
  });

  it('parses and validates: 66 books, 1,189 chapters, 31,103 verses', () => {
    expect(() => validateCorpus(corpus, ENGWEBP_RELEASE)).not.toThrow();
    expect(corpus.books).toHaveLength(66);
    expect(corpus.books.reduce((n, b) => n + b.chapterCount, 0)).toBe(1189);
    expect(corpus.verses).toHaveLength(31103);
    expect(contentSha256(corpus.verses)).toBe(ENGWEBP_RELEASE.contentSha256);
  });

  it('is internally consistent', () => {
    const { books, chapterCount, verseCount, emptyVerses } = ENGWEBP_RELEASE;
    expect(new Set(books.map((b) => b.code)).size).toBe(books.length);
    expect(books.reduce((n, b) => n + b.chapters, 0)).toBe(chapterCount);
    expect(verseCount).toBe(corpus.verses.length);
    expect(emptyVerses).toHaveLength(5);
  });

  it("quotes the publisher's license notice verbatim from the artifact", () => {
    const html = readZip(readCorpusArtifact(ENGWEBP_RELEASE)).get('copr.htm')?.toString('utf8');
    const notice = (html ?? '').replace(/<[^>]*>/g, ' ').replace(/[ \t\r\n]+/g, ' ');
    const { rightsRecord } = ENGWEBP_RELEASE;
    expect(notice).toContain(String(rightsRecord.notice));
    expect(notice).toContain(String(rightsRecord.trademarkCondition));
    expect(notice).toContain('29 Sep 2026'); // the generation date used as sourceRelease
  });
});

describe('validateCorpus refuses a corrupt or incomplete corpus', () => {
  const lastIndex = (c: ParsedCorpus): number => c.verses.length - 1;

  it.each<[string, string, (c: ParsedCorpus) => void]>([
    ['a missing final verse', 'CORPUS_VERSE_COUNT', (c) => void c.verses.pop()],
    ['a missing verse mid-chapter', 'CORPUS_BOUNDARIES', (c) => void c.verses.splice(1, 1)],
    ['a duplicated verse', 'CORPUS_BOUNDARIES', (c) => void c.verses.splice(1, 0, c.verses[1]!)],
    [
      'books out of canon order',
      'CORPUS_BOOKS',
      (c) => {
        [c.books[0], c.books[1]] = [c.books[1]!, c.books[0]!];
      },
    ],
    ['a wrong chapter count', 'CORPUS_CHAPTER_COUNT', (c) => void (c.books[0]!.chapterCount += 1)],
    [
      'text that is not NFC',
      'CORPUS_UNICODE',
      (c) => {
        const v = c.verses[0]!;
        v.text += 'é';
        v.textSha256 = sha256Hex(v.text);
      },
    ],
    [
      'a control character',
      'CORPUS_UNICODE',
      (c) => {
        const v = c.verses[0]!;
        v.text += '\u0007';
        v.textSha256 = sha256Hex(v.text);
      },
    ],
    [
      'leftover USFM syntax',
      'CORPUS_UNICODE',
      (c) => {
        const v = c.verses[0]!;
        v.text += ' \\wj';
        v.textSha256 = sha256Hex(v.text);
      },
    ],
    [
      'an empty verse the release does not list',
      'CORPUS_EMPTY_VERSE',
      (c) => {
        const v = c.verses[0]!;
        v.text = '';
        v.textSha256 = sha256Hex('');
      },
    ],
    [
      'a stale per-verse checksum',
      'CORPUS_VERSE_CHECKSUM',
      (c) => void (c.verses[0]!.textSha256 = sha256Hex('x')),
    ],
    [
      'changed text in a sampled verse',
      'CORPUS_SAMPLE',
      (c) => {
        const v = c.verses[lastIndex(c)]!;
        v.text += '.';
        v.textSha256 = sha256Hex(v.text);
      },
    ],
    [
      'changed text elsewhere',
      'CORPUS_CONTENT_CHECKSUM',
      (c) => {
        const v = c.verses[1]!;
        v.text += '.';
        v.textSha256 = sha256Hex(v.text);
      },
    ],
  ])('%s', (_case, code, change) => {
    expect(failureCode(mutated(change))).toBe(code);
  });

  it('refuses a book the release does not list (e.g. a deuterocanonical book)', () => {
    const release = { ...ENGWEBP_RELEASE, books: ENGWEBP_RELEASE.books.slice(1) };
    const parsed = parseArtifact(readCorpusArtifact(ENGWEBP_RELEASE), release);
    expect(failureCode(parsed, release)).toBe('CORPUS_BOOKS');
  });

  it('fails with a code that the process-failure line can carry, never the message', () => {
    const error = new CorpusValidationError('CORPUS_SAMPLE', 'a message naming a verse');
    expect(failureFields('corpus-import', error)).toStrictEqual({
      entrypoint: 'corpus-import',
      errorType: 'CorpusValidationError',
      code: 'CORPUS_SAMPLE',
    });
  });
});
