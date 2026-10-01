import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, queryFingerprint } from './search-cursor';
import type { SearchQuery } from './search-text';

const edition = '00000000-0000-4000-8000-000000000001';
const terms: SearchQuery = { mode: 'terms', tokens: ['alpha', 'beta'], separators: [] };
const position = { rank: '6.07927e-05', sequence: 45, chapter: 9, verse: 1 };

describe('search cursor', () => {
  it('round-trips a position for the same query', () => {
    const print = queryFingerprint(terms, edition, 'ROM');
    const cursor = encodeCursor(print, position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, print)).toStrictEqual(position);
  });

  it('is bound to the mode, tokens, edition and book filter', () => {
    const cursor = encodeCursor(queryFingerprint(terms, edition, undefined), position);
    for (const other of [
      queryFingerprint({ ...terms, mode: 'phrase', separators: [''] }, edition, undefined),
      queryFingerprint({ ...terms, tokens: ['alpha'] }, edition, undefined),
      queryFingerprint(terms, '00000000-0000-4000-8000-000000000002', undefined),
      queryFingerprint(terms, edition, 'ROM'),
    ]) {
      expect(decodeCursor(cursor, other)).toBeNull();
    }
  });

  it('rejects anything it did not issue', () => {
    const print = queryFingerprint(terms, edition, undefined);
    const forge = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      'not-a-cursor',
      forge({ rank: '1' }),
      forge([2, print, '0.1', 1, 1, 1]),
      forge([1, print, "0.1'; DROP TABLE bible_verse; --", 1, 1, 1]),
      forge([1, print, '-1', 1, 1, 1]),
      forge([1, print, 'NaN', 1, 1, 1]),
      forge([1, print, '0.1', 0, 1, 1]),
      forge([1, print, '0.1', 1, 1.5, 1]),
      forge([1, print, '0.1', 1, 1, 40000]),
    ]) {
      expect(decodeCursor(cursor, print)).toBeNull();
    }
  });
});
