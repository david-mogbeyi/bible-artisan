import { describe, expect, it } from 'vitest';
import {
  formatSpec,
  normalizeBookKey,
  normalizeReferenceInput,
  parseReference,
  type ParsedReference,
} from './parse-reference';

const ref = (
  key: string,
  spec: Extract<ParsedReference, { kind: 'reference' }>['spec'],
  hasColon = false,
): ParsedReference => ({
  kind: 'reference',
  spec,
  key,
  letters: key.replace(/^\d/, '').length,
  hasColon,
});

const malformed = (key: string, multiple = false, hasColon = true): ParsedReference => ({
  kind: 'malformed',
  multiple,
  key,
  letters: key.replace(/^\d/, '').length,
  hasColon,
});

describe('parseReference', () => {
  it.each<[string, ParsedReference]>([
    ['Romans', ref('romans', { form: 'book' })],
    ['Rom 9', ref('rom', { form: 'number', first: 9 })],
    ['Rom 9-10', ref('rom', { form: 'number-range', first: 9, last: 10 })],
    ['Rom 9:1', ref('rom', { form: 'chapter-verse', chapter: 9, verse: 1 }, true)],
    [
      'Romans 9:1-5',
      ref('romans', { form: 'verse-range', chapter: 9, verse: 1, endVerse: 5 }, true),
    ],
    [
      'Rom 8:38-9:5',
      ref(
        'rom',
        { form: 'chapter-verse-range', chapter: 8, verse: 38, endChapter: 9, endVerse: 5 },
        true,
      ),
    ],
    ['Jude 3', ref('jude', { form: 'number', first: 3 })],
    [
      'Song of Solomon 2:1',
      ref('songofsolomon', { form: 'chapter-verse', chapter: 2, verse: 1 }, true),
    ],
  ])('parses the supported shape %j', (input, expected) => {
    expect(parseReference(input)).toStrictEqual(expected);
  });

  it.each([
    ['Romans 9:1', 'romans'],
    ['ROMANS 9:1', 'romans'],
    ['rom 9:1', 'rom'],
    ['Rom. 9:1', 'rom'],
    ['ROM 9:1', 'rom'],
    ['Rom9:1', 'rom'],
    ['Rom 9 : 1', 'rom'],
    ['  Rom   9:1  ', 'rom'],
  ])('normalizes case, periods and spacing in %j', (input, key) => {
    expect(parseReference(input)).toStrictEqual(
      ref(key, { form: 'chapter-verse', chapter: 9, verse: 1 }, true),
    );
  });

  it.each([
    ['1 Tim 2:5', '1tim'],
    ['1Tim 2:5', '1tim'],
    ['1 Timothy 2:5', '1timothy'],
    ['I Timothy 2:5', '1timothy'],
    ['i tim 2:5', '1tim'],
  ])('reads the numeric book prefix of %j', (input, key) => {
    expect(parseReference(input)).toStrictEqual({
      kind: 'reference',
      spec: { form: 'chapter-verse', chapter: 2, verse: 5 },
      key,
      letters: key.length - 1,
      hasColon: true,
    });
  });

  it('reads Roman II and III prefixes and keeps Isaiah a word', () => {
    expect(parseReference('II Cor 5:17')).toMatchObject({ kind: 'reference', key: '2cor' });
    expect(parseReference('III John 2')).toMatchObject({ kind: 'reference', key: '3john' });
    expect(parseReference('Isaiah 53')).toMatchObject({ kind: 'reference', key: 'isaiah' });
  });

  it('keeps leading zeros as the same number and never adjusts a number', () => {
    expect(parseReference('Rom 09:01')).toStrictEqual(
      ref('rom', { form: 'chapter-verse', chapter: 9, verse: 1 }, true),
    );
    expect(parseReference('Rom 99:999')).toStrictEqual(
      ref('rom', { form: 'chapter-verse', chapter: 99, verse: 999 }, true),
    );
  });

  it.each([
    ['en dash', 'Rom 9:1\u20135'],
    ['em dash', 'Rom 9:1\u20145'],
    ['minus sign', 'Rom 9:1\u22125'],
    ['non-breaking hyphen', 'Rom 9:1\u20115'],
    ['full-width hyphen', 'Rom 9:1\uFF0D5'],
    ['no-break spaces', 'Rom\u00A09:1\u00A0-\u00A05'],
    ['full-width digits and colon', 'Rom \uFF19\uFF1A\uFF11-\uFF15'],
    ['zero-width characters', 'Ro\u200Bm 9\uFEFF:1-\u200D5'],
    ['an ideographic space', 'Rom\u30009:1-5'],
  ])('reads a range typed with %s exactly like its ASCII form', (_label, input) => {
    expect(parseReference(input)).toStrictEqual(parseReference('Rom 9:1-5'));
  });

  it.each([
    ['Rom 9:', false],
    ['Rom 9.1', false],
    ['Rom 0:1', false],
    ['Rom 9:0', false],
    ['Rom 0', false],
    ['Rom 9-10:5', false],
    ['Rom 9:1a', false],
    ['Rom 9:12345', false],
    ['Rom 9:1,3', true],
    ['Rom 9:1; 10:2', true],
    ['Rom 16:27-1 Cor 1:1', true],
    ['Rom 16:27-Gal 1:1', true],
  ])('treats %j as a malformed reference (multiple passages: %s)', (input, multiple) => {
    const parsed = parseReference(input);
    expect(parsed).toMatchObject({ kind: 'malformed', multiple, key: 'rom' });
  });

  it('records whether a malformed reference contained a colon', () => {
    expect(parseReference('Rom 9-10:5')).toStrictEqual(malformed('rom', false, true));
    expect(parseReference('Rom 0')).toStrictEqual(malformed('rom', false, false));
  });

  it.each(['"bearing witness"', '9:1', '1 2', 'Römer 9:1', 'faith, hope, love', '', '   '])(
    'returns not_reference for %j',
    (input) => {
      expect(parseReference(input)).toStrictEqual({ kind: 'not_reference' });
    },
  );

  it('leaves book matching to the resolver: plain words parse as book-only or book + number', () => {
    expect(parseReference('so')).toStrictEqual(ref('so', { form: 'book' }));
    expect(parseReference('bearing witness')).toStrictEqual(
      ref('bearingwitness', { form: 'book' }),
    );
    expect(parseReference('love 1')).toStrictEqual(ref('love', { form: 'number', first: 1 }));
  });

  it('refuses input over the length cap without parsing it', () => {
    expect(parseReference(`Rom 9:1${' '.repeat(200)}`)).toStrictEqual({ kind: 'not_reference' });
  });

  it('parses pathological inputs at the length cap quickly (no catastrophic backtracking)', () => {
    const inputs = [
      `${'a '.repeat(99)}1`,
      `${'a '.repeat(99)}!`,
      `${'a'.repeat(199)}!`,
      `${'i '.repeat(99)}1`,
      `1 ${'ab '.repeat(65)}:`,
      `${'a.'.repeat(99)}1`,
    ];
    const started = performance.now();
    for (const input of inputs) parseReference(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('normalizeReferenceInput', () => {
  it('applies NFKC, removes zero-width characters, unifies dashes and whitespace, lower-cases', () => {
    expect(
      normalizeReferenceInput('\u200B \uFF32\uFF2F\uFF2D\u00A0\uFF19\uFF1A\uFF11\u2013\uFF15 '),
    ).toBe('rom 9:1-5');
  });
});

describe('normalizeBookKey', () => {
  it.each([
    ['1 Samuel', '1samuel'],
    ['1Sa', '1sa'],
    ['1SA', '1sa'],
    ['Song of Solomon', 'songofsolomon'],
    ['Rom.', 'rom'],
  ])('normalizes %j to %j', (name, key) => {
    expect(normalizeBookKey(name)).toBe(key);
  });
});

describe('formatSpec', () => {
  it('re-renders each shape in ASCII', () => {
    expect(
      [
        { form: 'book' as const },
        { form: 'number' as const, first: 3 },
        { form: 'number-range' as const, first: 3, last: 5 },
        { form: 'chapter-verse' as const, chapter: 9, verse: 1 },
        { form: 'verse-range' as const, chapter: 9, verse: 1, endVerse: 5 },
        {
          form: 'chapter-verse-range' as const,
          chapter: 8,
          verse: 38,
          endChapter: 9,
          endVerse: 5,
        },
      ].map(formatSpec),
    ).toStrictEqual(['', '3', '3-5', '9:1', '9:1-5', '8:38-9:5']);
  });
});
