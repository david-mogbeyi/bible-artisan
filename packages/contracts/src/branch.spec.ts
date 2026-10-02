import { describe, expect, it } from 'vitest';
import {
  BRANCH_MEMBER_DUPLICATE,
  BRANCH_MEMBER_IN_BOTH,
  BRANCH_MEMBERS_EMPTY,
  branchMutationResponseSchema,
  branchSchema,
  createBranchRequestSchema,
  createBranchResponseSchema,
  MAX_BRANCH_MEMBER_CHANGES,
  updateBranchMembersRequestSchema,
} from './branch';

const A = '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const B = '9c0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const C = 'ac0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const T = '2026-10-02T10:00:00.000Z';

function issues(result: { success: boolean; error?: { issues: unknown[] } }) {
  return result.error?.issues.map((issue) => {
    const { path, message } = issue as { path: PropertyKey[]; message: string };
    return { path, message };
  });
}

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${i.toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-0a1b2c3d4e5f`,
  );

describe('createBranchRequestSchema', () => {
  it('accepts a root node id (lower-cased) and the study revision', () => {
    expect(
      createBranchRequestSchema.parse({ expectedRevision: 4, rootNodeId: A.toUpperCase() }),
    ).toStrictEqual({ expectedRevision: 4, rootNodeId: A });
  });

  it('is strict: no label, owner, study, revision or members can be sent', () => {
    for (const extra of [{ label: 'x' }, { ownerId: A }, { memberNodeIds: [B] }, { revision: 1 }]) {
      expect(
        createBranchRequestSchema.safeParse({ expectedRevision: 1, rootNodeId: A, ...extra })
          .success,
      ).toBe(false);
    }
    expect(createBranchRequestSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
  });
});

describe('updateBranchMembersRequestSchema', () => {
  it('accepts add and/or remove, lower-casing ids', () => {
    expect(
      updateBranchMembersRequestSchema.parse({
        expectedRevision: 2,
        add: [A.toUpperCase()],
        remove: [B],
      }),
    ).toStrictEqual({ expectedRevision: 2, add: [A], remove: [B] });
    expect(
      updateBranchMembersRequestSchema.parse({ expectedRevision: 1, remove: [C] }),
    ).toStrictEqual({ expectedRevision: 1, remove: [C] });
    expect(
      updateBranchMembersRequestSchema.safeParse({
        expectedRevision: 1,
        add: ids(MAX_BRANCH_MEMBER_CHANGES),
        remove: [A],
      }).success,
    ).toBe(true);
  });

  it('needs at least one id overall', () => {
    for (const body of [
      { expectedRevision: 1 },
      { expectedRevision: 1, add: [] },
      { expectedRevision: 1, add: [], remove: [] },
    ]) {
      expect(issues(updateBranchMembersRequestSchema.safeParse(body))).toStrictEqual([
        { path: ['add'], message: BRANCH_MEMBERS_EMPTY },
      ]);
    }
  });

  it('refuses more than 100 per list, a node twice in a list (in any case), and a node in both lists', () => {
    for (const list of ['add', 'remove'] as const) {
      expect(
        updateBranchMembersRequestSchema.safeParse({
          expectedRevision: 1,
          [list]: ids(MAX_BRANCH_MEMBER_CHANGES + 1),
        }).success,
      ).toBe(false);
      expect(
        issues(
          updateBranchMembersRequestSchema.safeParse({
            expectedRevision: 1,
            [list]: [A, B, A.toUpperCase()],
          }),
        ),
      ).toStrictEqual([{ path: [list, 2], message: BRANCH_MEMBER_DUPLICATE }]);
    }
    expect(
      issues(
        updateBranchMembersRequestSchema.safeParse({
          expectedRevision: 1,
          add: [A, B],
          remove: [C, B.toUpperCase()],
        }),
      ),
    ).toStrictEqual([{ path: ['remove', 1], message: BRANCH_MEMBER_IN_BOTH }]);
  });

  it('is strict and needs a revision', () => {
    expect(
      updateBranchMembersRequestSchema.safeParse({ expectedRevision: 1, add: [A], label: 'x' })
        .success,
    ).toBe(false);
    expect(updateBranchMembersRequestSchema.safeParse({ add: [A] }).success).toBe(false);
  });
});

describe('branch responses', () => {
  const branch = { id: A, rootNodeId: B, memberNodeIds: [C, A], revision: 3, createdAt: T };

  it('round-trips a full branch, a create response and a members response', () => {
    expect(branchSchema.parse(branch)).toStrictEqual(branch);
    const created = {
      ...branch,
      memberNodeIds: [],
      revision: 1,
      studyId: C,
      studyRevision: 7,
      lastEventSequence: '12',
    };
    expect(createBranchResponseSchema.parse(created)).toStrictEqual(created);
    const changed = { ...branch, lastEventSequence: '13' };
    expect(branchMutationResponseSchema.parse(changed)).toStrictEqual(changed);
  });
});
