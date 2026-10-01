import { describe, expect, it } from 'vitest';
import {
  canonicalSeparator,
  matchVerse,
  parseSearchQuery,
  type SearchQuery,
  tokenize,
  toCodePointRanges,
} from './search-text';

// Synthetic strings only: real-corpus behavior is covered by test/bible-search.int-spec.ts.

function query(input: string, mode: 'terms' | 'phrase'): SearchQuery {
  const parsed = parseSearchQuery(input, mode);
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

/** The highlighted substrings, so expectations read as text. */
function highlighted(q: SearchQuery, text: string): string[] | null {
  return matchVerse(q, text)?.map(({ start, end }) => text.slice(start, end)) ?? null;
}

describe('tokenize', () => {
  it('splits on every non-letter/digit and lower-cases tokens', () => {
    const { tokens, separators } = tokenize('Alpha’s  beta-gamma, “Delta”\u00a0x2!');
    expect(tokens.map((t) => t.norm)).toStrictEqual(['alpha', 's', 'beta', 'gamma', 'delta', 'x2']);
    expect(separators).toStrictEqual(['', '', '', ',', '']);
  });

  it('keeps accented letters and combining marks inside a token', () => {
    expect(tokenize('café naïve').tokens.map((t) => t.norm)).toStrictEqual(['café', 'naïve']);
  });
});

describe('canonicalSeparator', () => {
  it('drops whitespace, quotes, apostrophes and hyphens, unifies dashes, keeps punctuation', () => {
    expect(canonicalSeparator(' \u00a0\t')).toBe('');
    expect(canonicalSeparator(', “')).toBe(',');
    expect(canonicalSeparator('’')).toBe('');
    expect(canonicalSeparator('-')).toBe('');
    expect(canonicalSeparator(' – ')).toBe('—');
    expect(canonicalSeparator('—')).toBe('—');
    expect(canonicalSeparator('. ')).toBe('.');
    expect(canonicalSeparator('; (')).toBe(';(');
  });
});

describe('parseSearchQuery', () => {
  it('folds full-width ASCII and invisible characters before tokenizing', () => {
    expect(query('ＡＢＣ de\u200Bf', 'terms').tokens).toStrictEqual(['abc', 'def']);
  });

  it('keeps distinct terms in first-seen order, and the full sequence for a phrase', () => {
    expect(query('b A b a', 'terms')).toStrictEqual({
      mode: 'terms',
      tokens: ['b', 'a'],
      separators: [],
    });
    expect(query('"b, A b"', 'phrase')).toStrictEqual({
      mode: 'phrase',
      tokens: ['b', 'a', 'b'],
      separators: [',', ''],
    });
  });

  it('treats query operators as separators, never as syntax', () => {
    expect(query("a & !b | (c:*) <-> 'd' \\ e", 'terms').tokens).toStrictEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('reports input with no words or too many words', () => {
    expect(parseSearchQuery("&|!:*()<>'\\ “”", 'terms')).toBe('no_words');
    expect(parseSearchQuery(Array.from({ length: 21 }, (_, i) => `w${i}`).join(' '), 'terms')).toBe(
      'too_many_words',
    );
    expect(
      typeof parseSearchQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '), 'phrase'),
    ).toBe('object');
  });
});

describe('matchVerse: terms', () => {
  it('requires every term as a whole word, case-insensitively, and highlights each occurrence', () => {
    const q = query('Alpha gamma', 'terms');
    expect(highlighted(q, 'GAMMA then alpha, then gamma.')).toStrictEqual([
      'GAMMA',
      'alpha',
      'gamma',
    ]);
    expect(highlighted(q, 'alpha only')).toBeNull();
    expect(highlighted(q, 'alphas gammas')).toBeNull();
  });
});

describe('matchVerse: phrase', () => {
  it('matches consecutive tokens with neutral separators', () => {
    const q = query('alpha beta', 'phrase');
    expect(highlighted(q, 'x Alpha\u00a0beta y')).toStrictEqual(['Alpha\u00a0beta']);
    expect(highlighted(q, '“alpha” ‘beta’')).toStrictEqual(['alpha” ‘beta']);
    expect(highlighted(q, 'alpha-beta')).toStrictEqual(['alpha-beta']);
  });

  it('never invents adjacency across punctuation the query lacks', () => {
    const q = query('alpha beta', 'phrase');
    expect(highlighted(q, 'alpha. Beta')).toBeNull();
    expect(highlighted(q, 'alpha, beta')).toBeNull();
    expect(highlighted(q, 'alpha—beta')).toBeNull();
    expect(highlighted(q, 'alpha gamma beta')).toBeNull();
    expect(highlighted(query('alpha, beta', 'phrase'), 'alpha, “beta')).toStrictEqual([
      'alpha, “beta',
    ]);
    expect(highlighted(query('alpha – beta', 'phrase'), 'alpha—beta')).toStrictEqual([
      'alpha—beta',
    ]);
  });

  it('treats an apostrophe like the user’s straight one, and ignores edge punctuation', () => {
    expect(highlighted(query("Alpha's beta.", 'phrase'), 'the alpha’s beta, x')).toStrictEqual([
      'alpha’s beta',
    ]);
  });

  it('reports each non-overlapping occurrence', () => {
    expect(highlighted(query('a a', 'phrase'), 'a a a a a')).toStrictEqual(['a a', 'a a']);
  });

  it('does not match a phrase longer than the verse or a partial word', () => {
    expect(highlighted(query('alpha beta gamma', 'phrase'), 'alpha beta')).toBeNull();
    expect(highlighted(query('alph beta', 'phrase'), 'alpha beta')).toBeNull();
  });
});

describe('toCodePointRanges', () => {
  it('is the identity without astral characters', () => {
    expect(toCodePointRanges('abc def', [{ start: 4, end: 7 }])).toStrictEqual([
      { start: 4, end: 7 },
    ]);
  });

  it('counts an astral character as one code point', () => {
    const text = '\u{1D49C} alpha';
    const [range] = matchVerse(query('alpha', 'terms'), text) ?? [];
    expect(range).toStrictEqual({ start: 3, end: 8 });
    const [cp] = toCodePointRanges(text, range ? [range] : []);
    expect(cp).toStrictEqual({ start: 2, end: 7 });
    expect(Array.from(text).slice(cp?.start, cp?.end).join('')).toBe('alpha');
  });
});
