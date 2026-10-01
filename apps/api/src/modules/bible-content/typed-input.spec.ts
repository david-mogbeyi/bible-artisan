import { describe, expect, it } from 'vitest';
import { normalizeReferenceInput } from './reference/parse-reference';
import { parseSearchQuery } from './search/search-text';
import { foldTypedInput } from './typed-input';

describe('foldTypedInput', () => {
  it('removes every invisible character: soft hyphen, zero-width space/joiners, word joiner, BOM', () => {
    for (const ch of ['\u00AD', '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
      expect(foldTypedInput(`ab${ch}c`)).toBe('abc');
    }
  });

  it('folds full-width ASCII and applies NFC, but not NFKC', () => {
    expect(foldTypedInput('\uFF32\uFF4F\uFF4D \uFF19\uFF1A\uFF11')).toBe('Rom 9:1');
    expect(foldTypedInput('e\u0301')).toBe('\u00E9');
    expect(foldTypedInput('\u212A')).toBe('K');
    expect(foldTypedInput('\u00B2\u2161')).toBe('\u00B2\u2161');
  });

  it('is the fold both the reference parser and the search tokenizer read', () => {
    const typed = '\uFF32o\u00ADm\u2060 \u200B9';
    expect(normalizeReferenceInput(typed)).toBe('rom 9');
    expect(parseSearchQuery(typed, 'terms')).toStrictEqual({
      mode: 'terms',
      tokens: ['rom', '9'],
      separators: [],
    });
  });
});
