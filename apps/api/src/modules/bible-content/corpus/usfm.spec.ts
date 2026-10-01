import { describe, expect, it } from 'vitest';
import { parseArtifact, readArtifact } from './corpus';
import { readCorpusArtifact } from './corpus-importer';
import { ENGWEBP_RELEASE } from './engwebp-release';
import { collapseAsciiWhitespace, parseUsfmBook, usfmBookCode, UsfmFormatError } from './usfm';

/*
 * Every Scripture input here is sliced out of the committed publisher artifact at test time, and
 * every expectation is a property of, or an equivalence between, parses of those real lines.
 * No verse text is typed into this file (AGENTS.md rule 8). Synthetic inputs (for rejections)
 * carry placeholder letters only.
 */

const sources = new Map<string, string>();
for (const [name, data] of readArtifact(readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE)) {
  if (!name.endsWith('.usfm')) continue;
  const text = data.toString('utf8');
  sources.set(usfmBookCode(text), text);
}

function bookSource(code: string): string {
  const source = sources.get(code);
  if (!source) throw new Error(`no ${code} in the artifact`);
  return source;
}

/** The raw USFM of one verse: from its `\v N ` up to the next `\v` or `\c` marker. */
function rawVerse(code: string, chapter: number, verse: number): string {
  const source = bookSource(code);
  const chapterAt = source.search(new RegExp(`\\\\c ${chapter}[ \\n]`));
  const start = source.indexOf(`\\v ${verse} `, chapterAt);
  const rest = source.slice(start + 1);
  const end = rest.search(/\\[cv] /);
  return source.slice(start, end === -1 ? undefined : start + 1 + end);
}

/** Parses raw verse USFM inside a minimal synthetic book wrapper. */
function parseVerse(chapter: number, raw: string): string {
  const book = parseUsfmBook(`\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\c ${chapter}\n\\p\n${raw}`);
  expect(book.verses).toHaveLength(1);
  return book.verses[0]?.text ?? '';
}

function fullBookVerse(code: string, chapter: number, verse: number): string | undefined {
  return parseUsfmBook(bookSource(code)).verses.find(
    (v) => v.chapter === chapter && v.verse === verse,
  )?.text;
}

/** Content words of `\w …|…\w*` and `\+w …|…\w*` markers, in source order. */
function markedWords(raw: string): string[] {
  return [...raw.matchAll(/\\\+?w ([^|\\]*)\|/g)].map((m) => m[1] ?? '');
}

describe('parseUsfmBook on real WEB source lines', () => {
  it('drops Strong attributes and word markers but keeps every marked word, in order', () => {
    const raw = rawVerse('GEN', 1, 1);
    expect(raw).toContain('|strong="');
    const text = parseVerse(1, raw);
    expect(text).toBe(fullBookVerse('GEN', 1, 1));
    expect(text).not.toMatch(/strong|\\|\|/);
    let at = 0;
    for (const word of markedWords(raw)) {
      at = text.indexOf(word, at);
      expect(at).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles nested \\+w inside words-of-Jesus spans and removes footnotes', () => {
    const raw = rawVerse('LUK', 12, 6);
    expect(raw).toContain('\\+w ');
    expect(raw).toContain('\\wj ');
    const footnote = /\\f .*?\\f\*/s.exec(raw)?.[0] ?? '';
    const footnoteText = /\\ft (.*?)\\f\*/s.exec(raw)?.[1] ?? '';
    expect(footnoteText.length).toBeGreaterThan(10);

    const text = parseVerse(12, raw);
    expect(text).toBe(parseVerse(12, raw.replace(footnote, '')));
    expect(text).not.toContain(footnoteText.trim());
    expect(text).not.toMatch(/\\|\+|\|/);
    for (const word of markedWords(raw)) expect(text).toContain(word);
  });

  it('removes cross references with their content', () => {
    const [code, chapter, verse] = firstVerseWith('\\x ');
    const raw = rawVerse(code, chapter, verse);
    const crossReference = /\\x .*?\\x\*/s.exec(raw)?.[0] ?? '';
    const target = /\\xt (.*?)\\x\*/s.exec(raw)?.[1] ?? '';
    expect(target).not.toBe('');
    const text = parseVerse(chapter, raw);
    expect(text).toBe(parseVerse(chapter, raw.replace(crossReference, '')));
    expect(text).not.toContain(target.trim());
  });

  it('treats the space after an opening character marker as its delimiter (Selah in Ps 68:32)', () => {
    const raw = rawVerse('PSA', 68, 32);
    const marker = raw.indexOf('\\qs ');
    const selah = raw.slice(marker + '\\qs '.length, raw.indexOf('\\qs*'));
    // The character before the marker is joined directly to the marker's content.
    expect(parseVerse(68, raw)).toContain(`${raw.charAt(marker - 1)}${selah}`);
  });

  it('never leaves a space before closing punctuation anywhere in the corpus', () => {
    const corpus = parseArtifact(readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
    expect(corpus.verses.filter((v) => / [?.,;:!”’)]/.test(v.text))).toStrictEqual([]);
  });

  it('stores every \\d line as a superscription of the verse after it, under verse-text rules', () => {
    const source = bookSource('PSA');
    const book = parseUsfmBook(source);
    // Every raw `\d` line, located by the chapter it is in and the first verse after it.
    const lines = source.split('\n');
    const expected: { chapter: number; beforeVerse: number; text: string }[] = [];
    let chapter = 0;
    lines.forEach((line, i) => {
      chapter = Number(/^\\c (\d+)/.exec(line)?.[1] ?? chapter);
      if (!/^\\d /.test(line)) return;
      const next = lines.slice(i + 1).join('\n');
      const beforeVerse = Number(/\\v (\d+) /.exec(next)?.[1]);
      expect(next.search(/\\v \d+ /)).toBeLessThan(next.search(/\\c |$(?![\s\S])/));
      // The same content parsed as if it were a verse's text: same markup and whitespace rules.
      expected.push({ chapter, beforeVerse, text: parseVerse(chapter, `\\v 1 ${line.slice(3)}`) });
    });
    expect(expected).toHaveLength(ENGWEBP_RELEASE.superscriptionCount);
    expect(book.superscriptions).toStrictEqual(expected);
    // Titles open their psalm; the rest are Psalm 119 stanza headings between verses.
    expect(book.superscriptions.filter((d) => d.beforeVerse !== 1).map((d) => d.chapter)).toEqual(
      expect.arrayContaining([119]),
    );
    expect(
      new Set(book.superscriptions.filter((d) => d.beforeVerse !== 1).map((d) => d.chapter)),
    ).toStrictEqual(new Set([119]));
    for (const d of book.superscriptions) {
      expect(d.text).not.toBe('');
      expect(d.text).toBe(d.text.normalize('NFC'));
      expect(d.text).not.toMatch(/\\|\|/);
    }
  });

  it('removes a footnote inside a superscription, as it would in a verse', () => {
    const line = bookSource('PSA')
      .split('\n')
      .find((l) => l.startsWith('\\d ') && l.includes('\\f '));
    expect(line).toBeDefined();
    const raw = line ?? '';
    const footnote = /\\f .*?\\f\*/s.exec(raw)?.[0] ?? '';
    const wrap = (d: string): string =>
      `\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\c 1\n${d}\n\\q1\n\\v 1 x`;
    const [withNote] = parseUsfmBook(wrap(raw)).superscriptions;
    const [withoutNote] = parseUsfmBook(wrap(raw.replace(footnote, ''))).superscriptions;
    expect(withNote).toStrictEqual(withoutNote);
  });

  it('keeps Psalm superscriptions out of every verse', () => {
    const book = parseUsfmBook(bookSource('PSA'));
    expect(book.superscriptions.length).toBeGreaterThan(100);
    for (const d of book.superscriptions.filter((s) => s.beforeVerse === 1)) {
      const verses = book.verses.filter((v) => v.chapter === d.chapter);
      expect(verses.some((v) => v.text.includes(d.text))).toBe(false);
    }
  });

  it('keeps a Psalm 119 stanza heading out of the verses on either side of it', () => {
    const raw = rawVerse('PSA', 119, 8);
    const stanza = /\n\\d [^\n]*/.exec(raw)?.[0] ?? '';
    expect(stanza).not.toBe('');
    // Parsed alone, a trailing `\d` with no verse after it is refused; in the book, verse 8 is
    // exactly the verse without the stanza line, which becomes verse 9's superscription.
    expect(() => parseVerse(119, raw)).toThrow(UsfmFormatError);
    expect(fullBookVerse('PSA', 119, 8)).toBe(parseVerse(119, raw.replace(stanza, '')));
    const book = parseUsfmBook(bookSource('PSA'));
    const heading = book.superscriptions.find((d) => d.chapter === 119 && d.beforeVerse === 9);
    expect(heading?.text).toBe(parseVerse(119, `\\v 1 ${stanza.slice('\n\\d '.length)}`));
    expect(fullBookVerse('PSA', 119, 9)).not.toContain(heading?.text);
  });

  it('drops Song of Songs speaker labels inside a verse', () => {
    const raw = rawVerse('SNG', 1, 4);
    const speakers = raw.match(/\n\\sp [^\n]*/g) ?? [];
    expect(speakers.length).toBeGreaterThan(0);
    const withoutSpeakers = speakers.reduce((r, line) => r.replace(line, ''), raw);
    expect(parseVerse(1, raw)).toBe(parseVerse(1, withoutSpeakers));
  });

  it("preserves the publisher's no-break spaces", () => {
    const raw = rawVerse('JHN', 5, 11);
    const count = (s: string): number => s.split(' ').length - 1;
    expect(count(raw)).toBeGreaterThan(0);
    expect(count(parseVerse(5, raw))).toBe(count(raw));
  });

  it("reads the book code and the publisher's names from the headings", () => {
    const book = parseUsfmBook(bookSource('ROM'));
    expect(book.code).toBe('ROM');
    expect(bookSource('ROM')).toContain(`\\toc2 ${book.name}`);
    expect(bookSource('ROM')).toContain(`\\toc3 ${book.abbreviation}`);
  });
});

function firstVerseWith(marker: string): [string, number, number] {
  for (const [code, source] of sources) {
    if (ENGWEBP_RELEASE.ignoredBooks.includes(code)) continue;
    const at = source.indexOf(marker);
    if (at === -1) continue;
    const before = source.slice(0, at);
    const chapter = [...before.matchAll(/\\c (\d+)/g)].at(-1)?.[1];
    const verse = [...before.matchAll(/\\v (\d+) /g)].at(-1)?.[1];
    if (chapter && verse) return [code, Number(chapter), Number(verse)];
  }
  throw new Error(`no verse with ${marker}`);
}

describe('parseUsfmBook rejections (synthetic input)', () => {
  const wrap = (body: string): string => `\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\c 1\n\\p\n${body}`;

  it.each([
    ['an unsupported marker', wrap('\\v 1 a \\zz b\\zz*')],
    ['a verse bridge', wrap('\\v 1-2 a')],
    ['a duplicate verse', wrap('\\v 1 a\n\\v 1 b')],
    ['text outside any verse', wrap('a\n\\v 1 b')],
    ['a heading line that opens a verse', wrap('\\v 1 a\n\\s b \\v 2 c')],
    ['a superscription line that opens a verse', wrap('\\v 1 a\n\\d b \\v 2 c')],
    [
      'a superscription before any chapter',
      '\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\d a\n\\c 1\n\\v 1 b',
    ],
    ['a superscription at the end of a chapter', wrap('\\v 1 a\n\\d b\n\\q1\n\\c 2\n\\v 1 c')],
    ['a superscription at the end of the book', wrap('\\v 1 a\n\\d b\n\\q1')],
    ['two superscriptions before one verse', wrap('\\d a\n\\d b\n\\q1\n\\v 1 c')],
    ['a superscription marker inside a line', wrap('\\v 1 a \\d b')],
    ['a nested superscription marker', wrap('\\d a \\+d b\n\\q1\n\\v 1 c')],
    ['text between a superscription and its verse', wrap('\\d a\n\\q1 b\n\\v 1 c')],
    ['a verse before any chapter', '\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\v 1 a'],
    ['a missing \\id', '\\toc2 Test\n\\toc3 Tst\n\\c 1\n\\v 1 a'],
    ['missing book names', '\\id TST\n\\c 1\n\\v 1 a'],
  ])('refuses %s', (_case, source) => {
    expect(() => parseUsfmBook(source)).toThrow(UsfmFormatError);
  });
});

describe('parseUsfmBook superscriptions (synthetic input)', () => {
  it('attaches a title and a mid-chapter heading to the verses that follow them', () => {
    const book = parseUsfmBook(
      '\\id TST\n\\toc2 Test\n\\toc3 Tst\n\\c 1\n\\d a \\w b|strong="H1"\\w*  \n\\q1\n\\v 1 c\n' +
        '\\q1 d\n\\d e\n\\q1\n\\v 2 f',
    );
    expect(book.superscriptions).toStrictEqual([
      { chapter: 1, beforeVerse: 1, text: 'a b' },
      { chapter: 1, beforeVerse: 2, text: 'e' },
    ]);
    expect(book.verses).toStrictEqual([
      { chapter: 1, verse: 1, text: 'c d' },
      { chapter: 1, verse: 2, text: 'f' },
    ]);
  });
});

describe('collapseAsciiWhitespace', () => {
  it('collapses ASCII whitespace runs and trims, keeping U+00A0', () => {
    expect(collapseAsciiWhitespace(' a \n\t b  ')).toBe('a b ');
  });
});
