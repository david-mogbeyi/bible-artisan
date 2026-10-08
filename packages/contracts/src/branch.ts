import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';

/**
 * Study branches and their membership (BIB-60; PRD sections 8, 12, 23, 24). A branch is "an
 * investigation route rooted in a question or passage … a lightweight navigation grouping, not a
 * tree constraint": its nodes are its root plus its member nodes, a node may be in many branches,
 * and membership never implies or constrains an edge. A branch has no label: it is named by its
 * root ("Branch: " + the root's label), so no text travels here, only ids and integers.
 *
 * Revisions: starting a branch is a study change (`expectedRevision` is the study's, as for any
 * new study child); changing members checks the branch's own `revision` and never moves the
 * study's revision or content revision.
 */

/** PRD section 24 batch maximum, per list (`add`, `remove`). */
export const MAX_BRANCH_MEMBER_CHANGES = 100;

export const BRANCH_ROOT_TYPE_NOT_ALLOWED = 'BRANCH_ROOT_TYPE_NOT_ALLOWED';
export const BRANCH_EXISTS = 'BRANCH_EXISTS';
export const BRANCH_UNCHANGED = 'BRANCH_UNCHANGED';

export const BRANCH_ERROR_CODES = [
  BRANCH_ROOT_TYPE_NOT_ALLOWED,
  BRANCH_EXISTS,
  BRANCH_UNCHANGED,
] as const;
export type BranchErrorCode = (typeof BRANCH_ERROR_CODES)[number];

/** Fixed messages (422): never a node's text or a branch name. */
export const BRANCH_ERROR_MESSAGES: Record<BranchErrorCode, string> = {
  [BRANCH_ROOT_TYPE_NOT_ALLOWED]: 'A branch can start only at a question or a passage',
  [BRANCH_EXISTS]: 'A branch already starts at this node',
  [BRANCH_UNCHANGED]: 'Nothing to change in this branch',
};

/** Field-error copy (400). */
export const BRANCH_MEMBERS_EMPTY = 'Send at least one node to add or remove';
export const BRANCH_MEMBER_DUPLICATE = 'Each node can appear only once';
export const BRANCH_MEMBER_IN_BOTH = 'A node cannot be added and removed at once';

/** The node types a branch can start at (PRD section 8: "rooted in a question or passage"). */
export const BRANCH_ROOT_TYPES = ['question', 'scripture'] as const;

/**
 * A node id, lower-cased so duplicate detection matches PostgreSQL's uuid equality. Not checked as
 * a uuid here: like an id in a path, a malformed id is the same 404 as an absent or another
 * user's node (the server checks the shape before any query).
 */
const nodeIdSchema = z
  .string()
  .max(64)
  .transform((id) => id.toLowerCase());

/** One branch as read (`GET /graph`) and as changed. Ids and integers only. */
export const branchSchema = z.object({
  id: z.uuid(),
  rootNodeId: z.uuid(),
  /** The live member nodes, oldest membership first (ties by node id). Never the root. */
  memberNodeIds: z.array(z.uuid()),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export type Branch = z.infer<typeof branchSchema>;

/**
 * `POST /v1/studies/:studyId/branches`: start a branch at a live Question or Scripture node that
 * roots no branch yet. `expectedRevision` is the study's.
 */
export const createBranchRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  rootNodeId: nodeIdSchema,
});

export type CreateBranchRequest = z.input<typeof createBranchRequestSchema>;

/** 201 from `POST /branches`: the new branch (no members, revision 1) and the study's new revision. */
export const createBranchResponseSchema = branchSchema.extend({
  studyId: z.uuid(),
  studyRevision: z.number().int().positive(),
  lastEventSequence: eventSequenceSchema,
});

export type CreateBranchResponse = z.infer<typeof createBranchResponseSchema>;

const memberListSchema = z.array(nodeIdSchema).max(MAX_BRANCH_MEMBER_CHANGES);

/**
 * `PATCH /v1/studies/:studyId/branches/:branchId/members`: the branch's revision, and nodes to add
 * and/or remove (each list at most 100, no node twice in a list, none in both, at least one id
 * overall). Adding the root or a member, and removing a non-member or the root, change nothing.
 */
export const updateBranchMembersRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    add: memberListSchema.optional(),
    remove: memberListSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const add = body.add ?? [];
    const remove = body.remove ?? [];
    if (add.length + remove.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['add'], message: BRANCH_MEMBERS_EMPTY });
    }
    for (const list of ['add', 'remove'] as const) {
      const seen = new Set<string>();
      (body[list] ?? []).forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({ code: 'custom', path: [list, index], message: BRANCH_MEMBER_DUPLICATE });
        }
        seen.add(id);
      });
    }
    const adding = new Set(add);
    remove.forEach((id, index) => {
      if (adding.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['remove', index], message: BRANCH_MEMBER_IN_BOTH });
      }
    });
  });

export type UpdateBranchMembersRequest = z.input<typeof updateBranchMembersRequestSchema>;

/** 200 from `PATCH /members`: the branch after the change (its full live member list). */
export const branchMutationResponseSchema = branchSchema.extend({
  lastEventSequence: eventSequenceSchema,
});

export type BranchMutationResponse = z.infer<typeof branchMutationResponseSchema>;
