import { describe, expect, it } from 'vitest';
import { resolveReferenceRequestSchema, resolveReferenceResponseSchema } from './bible';

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
