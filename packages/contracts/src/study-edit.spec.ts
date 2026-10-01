import { describe, expect, it } from 'vitest';
import {
  MAX_STUDY_TAGS,
  normalizeTagName,
  STUDY_EDIT_EMPTY,
  TAG_DUPLICATE,
  TAG_EMPTY,
  TAG_TOO_LONG,
  tagKey,
  TOO_MANY_TAGS,
  updateStudyRequestSchema,
} from './study-edit';
import { USER_TEXT_INVALID_CHARACTERS } from './user-text';

const nodeId = '00000000-0000-4000-8000-00000000000A';

const issuesOf = (body: unknown) => {
  const result = updateStudyRequestSchema.safeParse(body);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

describe('normalizeTagName / tagKey', () => {
  it('applies NFC, trims, and collapses whitespace runs; the key is lower-cased', () => {
    expect(normalizeTagName('  Grace \t alone \n')).toBe('Grace alone');
    // "a" + a combining acute accent composes to one code point.
    expect(normalizeTagName('Gráce')).toBe('Gráce');
    expect(tagKey(' GRACE  Alone')).toBe('grace alone');
    expect(tagKey('Gráce')).toBe(tagKey('GRÁCE'));
  });
});

describe('updateStudyRequestSchema', () => {
  it('accepts each editable field, trimming and normalizing text', () => {
    expect(
      updateStudyRequestSchema.parse({
        expectedRevision: 3,
        title: '  New title ',
        description: ' Notes ',
        mainQuestion: { text: ' Why? ' },
        pinned: true,
        tags: ['  grace  alone', 'Faith'],
      }),
    ).toStrictEqual({
      expectedRevision: 3,
      title: 'New title',
      description: 'Notes',
      mainQuestion: { text: 'Why?' },
      pinned: true,
      tags: ['grace alone', 'Faith'],
    });
    expect(
      updateStudyRequestSchema.parse({ expectedRevision: 1, mainQuestion: { nodeId } }),
    ).toStrictEqual({ expectedRevision: 1, mainQuestion: { nodeId: nodeId.toLowerCase() } });
    expect(
      updateStudyRequestSchema.parse({ expectedRevision: 1, description: null }),
    ).toStrictEqual({ expectedRevision: 1, description: null });
    expect(updateStudyRequestSchema.parse({ expectedRevision: 1, tags: [] })).toStrictEqual({
      expectedRevision: 1,
      tags: [],
    });
  });

  it('needs at least one editable field', () => {
    expect(issuesOf({ expectedRevision: 1 })).toStrictEqual([
      { path: [], message: STUDY_EDIT_EMPTY },
    ]);
  });

  it('refuses unknown members, a cleared title, an empty description, and a question with both forms', () => {
    expect(issuesOf({ expectedRevision: 1, title: 'x', ownerId: nodeId })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, title: null })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, title: '   ' })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, description: '' })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, mainQuestion: { text: 'Why?', nodeId } })).toHaveLength(
      1,
    );
    expect(issuesOf({ expectedRevision: 1, mainQuestion: null })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, description: 'x'.repeat(2001) })).toHaveLength(1);
  });

  it('refuses duplicate, empty, long, control-character, and too many tags with fixed copy', () => {
    expect(issuesOf({ expectedRevision: 1, tags: ['Grace', ' grace '] })).toStrictEqual([
      { path: ['tags'], message: TAG_DUPLICATE },
    ]);
    expect(issuesOf({ expectedRevision: 1, tags: ['  '] })).toStrictEqual([
      { path: ['tags', 0], message: TAG_EMPTY },
    ]);
    expect(issuesOf({ expectedRevision: 1, tags: ['x'.repeat(51)] })).toStrictEqual([
      { path: ['tags', 0], message: TAG_TOO_LONG },
    ]);
    expect(issuesOf({ expectedRevision: 1, tags: ['a\u000bb'] })).toStrictEqual([
      { path: ['tags', 0], message: USER_TEXT_INVALID_CHARACTERS },
    ]);
    const many = Array.from({ length: MAX_STUDY_TAGS + 1 }, (_, i) => `t${i}`);
    expect(issuesOf({ expectedRevision: 1, tags: many })).toStrictEqual([
      { path: ['tags'], message: TOO_MANY_TAGS },
    ]);
    expect(issuesOf({ expectedRevision: 1, tags: many.slice(1) })).toStrictEqual([]);
  });
});
