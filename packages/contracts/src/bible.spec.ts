import { describe, expect, it } from 'vitest';
import {
  resolveReferenceRequestSchema,
  resolveReferenceResponseSchema,
  searchBibleQuerySchema,
  searchBibleResponseSchema,
} from './bible';

const editionId = '00000000-0000-4000-8000-000000000001';

describe('resolveReferenceRequestSchema', () => {
  it('trims the input and accepts up to 200 characters', () => {
    expect(resolveReferenceRequestSchema.parse({ input: '  Rom 9:1 ', editionId })).toStrictEqual({
      input: 'Rom 9:1',
      editionId,
    });
    expect(
      resolveReferenceRequestSchema.safeParse({ input: 'a'.repeat(200), editionId }).success,
    ).toBe(true);
  });

  it('rejects blank, oversized, and non-UUID-edition requests', () => {
    for (const body of [
      { input: '   ', editionId },
      { input: 'a'.repeat(201), editionId },
      { input: 'Rom 9:1', editionId: 'webp' },
      { input: 'Rom 9:1' },
    ]) {
      expect(resolveReferenceRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('resolveReferenceResponseSchema', () => {
  it('accepts each outcome and nothing else', () => {
    const reference = {
      id: '00000000-0000-4000-8000-000000000002',
      editionId,
      bookCode: 'ROM',
      startChapter: 9,
      startVerse: 1,
      endChapter: 9,
      endVerse: 1,
      label: 'Romans 9:1',
    };
    expect(
      resolveReferenceResponseSchema.safeParse({ outcome: 'resolved', reference }).success,
    ).toBe(true);
    expect(
      resolveReferenceResponseSchema.safeParse({
        outcome: 'ambiguous',
        candidates: [{ bookCode: 'JUD', bookName: 'Jude', input: 'Jude 3' }],
      }).success,
    ).toBe(true);
    expect(resolveReferenceResponseSchema.safeParse({ outcome: 'not_reference' }).success).toBe(
      true,
    );
    expect(resolveReferenceResponseSchema.safeParse({ outcome: 'invalid' }).success).toBe(false);
  });
});

describe('searchBibleQuerySchema', () => {
  it('applies defaults, trims q, and parses limit from its decimal string', () => {
    expect(searchBibleQuerySchema.parse({ q: ' faith ', editionId })).toStrictEqual({
      q: 'faith',
      mode: 'terms',
      editionId,
    });
    expect(
      searchBibleQuerySchema.parse({
        q: 'faith',
        mode: 'phrase',
        editionId,
        book: 'ROM',
        cursor: 'abc_-1',
        limit: '100',
      }),
    ).toStrictEqual({
      q: 'faith',
      mode: 'phrase',
      editionId,
      book: 'ROM',
      cursor: 'abc_-1',
      limit: 100,
    });
  });

  it('rejects out-of-bounds, malformed, and repeated parameters', () => {
    for (const query of [
      { q: '   ', editionId },
      { q: 'a'.repeat(201), editionId },
      { q: ['a', 'b'], editionId },
      { q: 'faith', editionId, mode: 'semantic' },
      { q: 'faith', editionId: 'webp' },
      { q: 'faith', editionId, book: 'rom' },
      { q: 'faith', editionId, cursor: 'a+b/=' },
      { q: 'faith', editionId, cursor: 'a'.repeat(513) },
      { q: 'faith', editionId, limit: '0' },
      { q: 'faith', editionId, limit: '101' },
      { q: 'faith', editionId, limit: '1e1' },
      { q: 'faith', editionId, limit: '-5' },
    ]) {
      expect(searchBibleQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('searchBibleResponseSchema', () => {
  const result = {
    reference: { bookCode: 'ROM', chapter: 9, verse: 1, label: 'Romans 9:1' },
    text: 'x',
    highlights: [{ start: 0, end: 1 }],
  };

  it('accepts a page and rejects a negative highlight offset', () => {
    expect(
      searchBibleResponseSchema.safeParse({
        results: [result],
        nextCursor: null,
        referenceSuggestion: null,
      }).success,
    ).toBe(true);
    expect(
      searchBibleResponseSchema.safeParse({
        results: [{ ...result, highlights: [{ start: -1, end: 1 }] }],
        nextCursor: 'c',
        referenceSuggestion: null,
      }).success,
    ).toBe(false);
  });

  it('carries a resolved or ambiguous book suggestion, never not_reference, and requires the field', () => {
    const reference = {
      id: '00000000-0000-4000-8000-000000000002',
      editionId,
      bookCode: 'JOB',
      startChapter: 1,
      startVerse: 1,
      endChapter: 1,
      endVerse: 22,
      label: 'Job 1',
    };
    const page = { results: [result], nextCursor: null };
    for (const referenceSuggestion of [
      { outcome: 'resolved', reference },
      {
        outcome: 'ambiguous',
        candidates: [{ bookCode: 'JDG', bookName: 'Judges', input: 'Judges' }],
      },
    ]) {
      expect(searchBibleResponseSchema.safeParse({ ...page, referenceSuggestion }).success).toBe(
        true,
      );
    }
    for (const body of [
      { ...page, referenceSuggestion: { outcome: 'not_reference' } },
      { ...page, referenceSuggestion: { outcome: 'invalid' } },
      page,
    ]) {
      expect(searchBibleResponseSchema.safeParse(body).success).toBe(false);
    }
  });
});
