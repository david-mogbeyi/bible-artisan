import { describe, expect, it } from 'vitest';
import {
  createAnnotationRequestSchema,
  HIGHLIGHT_COLOR_NAMES,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_EDIT_EMPTY,
  HIGHLIGHT_LABEL_INVALID,
  HIGHLIGHT_LABEL_TOO_LONG,
  highlightLabelSchema,
  updateAnnotationRequestSchema,
} from './annotation';

const ANCHOR = {
  version: 1,
  editionId: '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  bookCode: 'ROM',
  kind: 'phrase',
  segments: [{ chapter: 9, verse: 1, start: 0, end: 6, textSha256: 'a'.repeat(64) }],
  quote: 'I tell',
};

describe('highlights (BIB-24)', () => {
  it('names every color, so color is never the only signal', () => {
    expect(HIGHLIGHT_COLORS.map((color) => HIGHLIGHT_COLOR_NAMES[color])).toStrictEqual([
      'Yellow',
      'Green',
      'Blue',
      'Pink',
    ]);
  });

  it('trims a label, keeps up to 80 code points, and turns a blank one into no label', () => {
    expect(highlightLabelSchema.parse('  Witness ')).toBe('Witness');
    expect(highlightLabelSchema.parse('🙂'.repeat(80))).toBe('🙂'.repeat(80));
    expect(highlightLabelSchema.parse('   ')).toBeNull();
    expect(highlightLabelSchema.parse(null)).toBeNull();
  });

  it('refuses a label over 80 code points or with line breaks and control characters', () => {
    const messages = (value: string) =>
      highlightLabelSchema.safeParse(value).error?.issues.map((issue) => issue.message);
    expect(messages('x'.repeat(81))).toStrictEqual([HIGHLIGHT_LABEL_TOO_LONG]);
    for (const value of ['a\nb', 'a\u0007b', 'a b', 'a\uD800b']) {
      expect(messages(value)).toStrictEqual([HIGHLIGHT_LABEL_INVALID]);
    }
  });

  it('creates with a durable anchor and one of the four colors, nothing else', () => {
    const body = { expectedRevision: 1, anchor: ANCHOR, colorToken: 'yellow' };
    expect(createAnnotationRequestSchema.safeParse(body).success).toBe(true);
    for (const bad of [
      { ...body, colorToken: 'red' },
      { ...body, anchor: { ...ANCHOR, version: 2 } },
      { ...body, editionId: ANCHOR.editionId },
      { anchor: ANCHOR, colorToken: 'yellow' },
    ]) {
      expect(createAnnotationRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('updates a color and/or label and needs at least one', () => {
    expect(
      updateAnnotationRequestSchema.safeParse({ expectedRevision: 1, label: null }).success,
    ).toBe(true);
    expect(
      updateAnnotationRequestSchema
        .safeParse({ expectedRevision: 1 })
        .error?.issues.map((issue) => issue.message),
    ).toStrictEqual([HIGHLIGHT_EDIT_EMPTY]);
  });
});
