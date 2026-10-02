import { describe, expect, it } from 'vitest';
import {
  createEdgeRequestSchema,
  DEFAULT_EDGE_TYPES,
  DIRECTED_EDGE_TYPES,
  EDGE_EDIT_EMPTY,
  EDGE_PHRASES,
  EDGE_SELF_CONNECTION,
  EDGE_TYPE_NAMES,
  EDGE_TYPES,
  isSymmetricEdgeType,
  requiresQuestionTarget,
  sameDirectionClassTypes,
  SYMMETRIC_EDGE_TYPES,
  updateEdgeRequestSchema,
} from './edge';
import { USER_TEXT_INVALID_CHARACTERS } from './user-text';

const A = '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const B = '9c0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CREATE = { expectedRevision: 3, sourceNodeId: A, targetNodeId: B, type: 'supports' };

function issues(result: { success: boolean; error?: { issues: unknown[] } }) {
  return result.error?.issues.map((issue) => {
    const { path, message } = issue as { path: PropertyKey[]; message: string };
    return { path, message };
  });
}

describe('edge types', () => {
  it('has the 15 PRD types, two of them two-way, each with a name and both phrases', () => {
    expect(EDGE_TYPES).toHaveLength(15);
    expect(new Set(EDGE_TYPES).size).toBe(15);
    expect([...SYMMETRIC_EDGE_TYPES]).toStrictEqual(['parallels', 'related_to']);
    expect(EDGE_TYPES.filter(isSymmetricEdgeType)).toStrictEqual(['parallels', 'related_to']);
    for (const type of EDGE_TYPES) {
      expect(EDGE_TYPE_NAMES[type]).toMatch(/\S/);
      expect(EDGE_PHRASES[type].outgoing).toMatch(/\S/);
      expect(EDGE_PHRASES[type].incoming).toMatch(/\S/);
    }
    for (const type of SYMMETRIC_EDGE_TYPES) {
      expect(EDGE_PHRASES[type].outgoing).toBe(EDGE_PHRASES[type].incoming);
    }
  });

  it('offers a default subset of the types, and same-class changes only', () => {
    expect(DEFAULT_EDGE_TYPES.every((type) => EDGE_TYPES.includes(type))).toBe(true);
    expect(sameDirectionClassTypes('supports')).toStrictEqual(DIRECTED_EDGE_TYPES);
    expect(sameDirectionClassTypes('related_to')).toStrictEqual(SYMMETRIC_EDGE_TYPES);
    expect(EDGE_TYPES.filter(requiresQuestionTarget)).toStrictEqual(['answers', 'raises_question']);
  });
});

describe('createEdgeRequestSchema', () => {
  it('accepts a connect, lower-casing ids, trimming the note and storing blank as null', () => {
    expect(
      createEdgeRequestSchema.parse({ ...CREATE, sourceNodeId: A.toUpperCase(), note: '  Why  ' }),
    ).toStrictEqual({ ...CREATE, note: 'Why' });
    expect(createEdgeRequestSchema.parse({ ...CREATE, note: '   ' }).note).toBeNull();
    expect(createEdgeRequestSchema.parse({ ...CREATE, note: null }).note).toBeNull();
    expect(createEdgeRequestSchema.parse(CREATE).note).toBeUndefined();
  });

  it('refuses a self-edge on targetNodeId, even in another letter case', () => {
    const result = createEdgeRequestSchema.safeParse({
      ...CREATE,
      targetNodeId: A.toUpperCase(),
    });
    expect(issues(result)).toStrictEqual([
      { path: ['targetNodeId'], message: EDGE_SELF_CONNECTION },
    ]);
  });

  it('refuses unknown keys, unknown types, long notes and control characters', () => {
    for (const extra of [{ origin: 'user' }, { ownerId: A }, { studyId: A }, { revision: 1 }]) {
      expect(createEdgeRequestSchema.safeParse({ ...CREATE, ...extra }).success).toBe(false);
    }
    expect(createEdgeRequestSchema.safeParse({ ...CREATE, type: 'implies' }).success).toBe(false);
    expect(createEdgeRequestSchema.safeParse({ ...CREATE, note: 'x'.repeat(2000) }).success).toBe(
      true,
    );
    expect(createEdgeRequestSchema.safeParse({ ...CREATE, note: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      issues(createEdgeRequestSchema.safeParse({ ...CREATE, note: 'a\u0007b' })),
    ).toStrictEqual([{ path: ['note'], message: USER_TEXT_INVALID_CHARACTERS }]);
  });
});

describe('updateEdgeRequestSchema', () => {
  it('needs a type or a note; null clears the note', () => {
    expect(issues(updateEdgeRequestSchema.safeParse({ expectedRevision: 1 }))).toStrictEqual([
      { path: [], message: EDGE_EDIT_EMPTY },
    ]);
    expect(updateEdgeRequestSchema.parse({ expectedRevision: 1, note: null })).toStrictEqual({
      expectedRevision: 1,
      note: null,
    });
    expect(updateEdgeRequestSchema.parse({ expectedRevision: 1, type: 'qualifies' })).toStrictEqual(
      { expectedRevision: 1, type: 'qualifies' },
    );
    expect(
      updateEdgeRequestSchema.safeParse({ expectedRevision: 1, type: 'x', note: 'n' }).success,
    ).toBe(false);
    expect(
      updateEdgeRequestSchema.safeParse({ expectedRevision: 1, note: 'n', sourceNodeId: A })
        .success,
    ).toBe(false);
  });
});
