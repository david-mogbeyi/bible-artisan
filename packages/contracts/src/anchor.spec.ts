import { describe, expect, it } from 'vitest';
import {
  anchorSelectionSchema,
  joinAnchorQuote,
  MAX_ANCHOR_OFFSET,
  MAX_ANCHOR_QUOTE_LENGTH,
  resolveAnchorResponseSchema,
  scriptureAnchorSchema,
} from './anchor';

const editionId = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(64);
const selection = {
  editionId,
  bookCode: 'ROM',
  kind: 'phrase' as const,
  segments: [{ chapter: 9, verse: 1, start: 2, end: 5 }],
  quote: 'abc',
};

describe('anchorSelectionSchema', () => {
  it('accepts a well-formed selection', () => {
    expect(anchorSelectionSchema.parse(selection)).toStrictEqual(selection);
  });

  it('rejects malformed shapes before any corpus check', () => {
    const segment = selection.segments[0];
    for (const body of [
      { ...selection, segments: [] },
      { ...selection, segments: Array.from({ length: 201 }, () => segment) },
      { ...selection, segments: [{ ...segment, start: 6, end: 5 }] },
      { ...selection, segments: [{ ...segment, start: -1 }] },
      { ...selection, segments: [{ ...segment, end: MAX_ANCHOR_OFFSET + 1 }] },
      { ...selection, segments: [{ ...segment, start: 1.5 }] },
      { ...selection, kind: 'word' },
      { ...selection, bookCode: 'rom' },
      { ...selection, editionId: 'webp' },
      { ...selection, quote: 'x'.repeat(MAX_ANCHOR_QUOTE_LENGTH + 1) },
    ]) {
      expect(anchorSelectionSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('scriptureAnchorSchema', () => {
  const anchor = {
    version: 1 as const,
    ...selection,
    segments: [{ ...selection.segments[0], textSha256: sha }],
  };

  it('accepts version 1 with lower-case hex checksums only', () => {
    expect(scriptureAnchorSchema.parse(anchor)).toStrictEqual(anchor);
    for (const body of [
      { ...anchor, version: 2 },
      { ...anchor, segments: [{ ...anchor.segments[0], textSha256: 'A'.repeat(64) }] },
      { ...anchor, segments: [{ ...anchor.segments[0], textSha256: undefined }] },
    ]) {
      expect(scriptureAnchorSchema.safeParse(body).success).toBe(false);
    }
  });

  it('allows an unresolved outcome with no reference, and only known reasons', () => {
    expect(
      resolveAnchorResponseSchema.safeParse({
        outcome: 'unresolved',
        reason: 'ANCHOR_CHECKSUM_MISMATCH',
        anchor,
        reference: null,
      }).success,
    ).toBe(true);
    expect(
      resolveAnchorResponseSchema.safeParse({
        outcome: 'unresolved',
        reason: 'NEARBY',
        anchor,
        reference: null,
      }).success,
    ).toBe(false);
  });
});

describe('joinAnchorQuote', () => {
  it('joins non-empty slices with one space and keeps every character as given', () => {
    expect(joinAnchorQuote(['a b', '', '“c”'])).toBe('a b “c”');
    expect(joinAnchorQuote(['', ''])).toBe('');
  });
});
