import { Injectable } from '@nestjs/common';
import {
  type Branch,
  BRANCH_EXISTS,
  BRANCH_ROOT_TYPE_NOT_ALLOWED,
  BRANCH_ROOT_TYPES,
  BRANCH_UNCHANGED,
  type BranchMutationResponse,
  createBranchRequestSchema,
  type CreateBranchResponse,
  type StudyNodeType,
  updateBranchMembersRequestSchema,
} from '@bible-artisan/contracts';
import { BranchRuleError, NotFoundError } from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { StudyBranchMember } from '../../database/models/study-branch-member.model';
import { StudyBranch } from '../../database/models/study-branch.model';
import { StudyNode } from '../../database/models/study-node.model';
import { StudyRevisionService } from '../study/study-revision.service';

/**
 * Branch events (BIB-60), one per changing request, ids only: never a node's text or a branch
 * name (NFR-PRIV-001). `branchId` travels in the payload (the `study_event.branch_id` column is
 * BIB-55's). Intended visibility, for BIB-55's visibility column: `branch_created` is
 * thread-visible (starting a second branch is a deliberate act, PRD section 10);
 * `branch_members_changed` is internal-only (organizing, like `node_position_saved`).
 */
export const BRANCH_EVENTS = {
  created: 'branch_created',
  membersChanged: 'branch_members_changed',
} as const;

const ROOT_TYPES: ReadonlySet<StudyNodeType> = new Set(BRANCH_ROOT_TYPES);

/** Nodes to add to and remove from a branch. Ids are lower-case (as the request schema outputs). */
export interface MemberChanges {
  add?: readonly string[];
  remove?: readonly string[];
}

/** The net change: what was actually inserted and deleted. Both empty means nothing was written. */
export interface MemberChangeResult {
  addedNodeIds: string[];
  removedNodeIds: string[];
}

/**
 * Changes a branch's membership inside any study mutation's `work`, under the study lock: the
 * members route now, and BIB-33's automatic membership (nodes created or visited while a branch is
 * active) inside its own mutations later. One function, so the rules cannot drift:
 *
 * 1. Every id in `add` and `remove` must be a live node of this study and owner: a malformed,
 *    absent, deleted, another study's or another owner's id is 404 before anything is written (the
 *    composite FK refuses such rows in SQL too).
 * 2. Per-id no-ops: adding the root or an existing member, removing a non-member or the root.
 * 3. Insert the new member rows (one statement) and delete the removed ones (one statement).
 *
 * It neither checks a revision nor appends an event: the caller does both (the route checks the
 * branch's revision and records `branch_members_changed`), and decides what an empty net change
 * means (the route refuses it with 422 `BRANCH_UNCHANGED`).
 */
export async function changeBranchMembers(
  m: StudyMutation,
  branch: Pick<StudyBranch, 'id' | 'rootNodeId'>,
  { add = [], remove = [] }: MemberChanges,
): Promise<MemberChangeResult> {
  const ids = [...new Set([...add, ...remove])];
  if (ids.length === 0) return { addedNodeIds: [], removedNodeIds: [] };
  // A malformed id is the same 404 as an absent node, and never reaches PostgreSQL (a 500).
  if (!ids.every(isResourceId)) throw new NotFoundError();
  const scope = { studyId: m.studyId, ownerId: m.ownerId };
  const live = await StudyNode.count({ where: { ...scope, id: ids, deletedAt: null } });
  if (live !== ids.length) throw new NotFoundError();

  const current = await StudyBranchMember.findAll({
    where: { ...scope, branchId: branch.id, nodeId: ids },
    attributes: ['nodeId'],
  });
  const members = new Set(current.map((row) => row.nodeId));
  const addedNodeIds = [...new Set(add)].filter(
    (id) => id !== branch.rootNodeId && !members.has(id),
  );
  const removedNodeIds = [...new Set(remove)].filter((id) => members.has(id));

  if (addedNodeIds.length > 0) {
    await StudyBranchMember.bulkCreate(
      addedNodeIds.map((nodeId) => ({ ...scope, branchId: branch.id, nodeId })),
      { transaction: m.transaction },
    );
  }
  if (removedNodeIds.length > 0) {
    await StudyBranchMember.destroy({
      where: { ...scope, branchId: branch.id, nodeId: removedNodeIds },
      transaction: m.transaction,
    });
  }
  return { addedNodeIds, removedNodeIds };
}

/**
 * A branch's live member node ids: oldest membership first, ties by node id. Members whose node
 * was soft-deleted keep their row (BIB-31's restore) and are left out. Two statements whatever the
 * branch's size.
 */
async function liveMemberIds(m: StudyMutation, branchId: string): Promise<string[]> {
  const scope = { studyId: m.studyId, ownerId: m.ownerId };
  const rows = await StudyBranchMember.findAll({
    where: { ...scope, branchId },
    attributes: ['nodeId'],
    order: [
      ['createdAt', 'ASC'],
      ['nodeId', 'ASC'],
    ],
  });
  if (rows.length === 0) return [];
  const live = await StudyNode.findAll({
    where: { ...scope, id: rows.map((row) => row.nodeId), deletedAt: null },
    attributes: ['id'],
  });
  const liveIds = new Set(live.map((node) => node.id));
  return rows.map((row) => row.nodeId).filter((id) => liveIds.has(id));
}

function branchFields(branch: StudyBranch, memberNodeIds: string[]): Branch {
  return {
    id: branch.id,
    rootNodeId: branch.rootNodeId,
    memberNodeIds,
    revision: branch.revision,
    createdAt: branch.createdAt.toISOString(),
  };
}

/**
 * Starting branches and changing their members (BIB-60). Graph owns `study_branch_member` and
 * every branch change after creation; Study's `StudyGraphService.ensureInitialBranch` stays the
 * only creator of a study's initial branch. Every write goes through `MutationService.execute`
 * (Idempotency-Key receipt, study lock, lifecycle guard, revision check, one StudyEvent in the same
 * transaction), with `bumpsContentRevision: false`: a branch is navigation grouping, not content
 * (PRD sections 8, 18). Responses carry ids and integers only (they are stored on receipts).
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly mutations: MutationService,
    private readonly studyRevisions: StudyRevisionService,
  ) {}

  /**
   * `POST /studies/:studyId/branches`. A new study child, so `expectedRevision` is the study's
   * (as for nodes, edges and notes) and the study revision moves. Checked in order under the
   * study lock: study revision (409), root a live node of this study (404), a Question or
   * Scripture node (422), no branch rooted there yet (422; the unique key is the backstop).
   */
  async create(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(createBranchRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
        if (!isResourceId(body.rootNodeId)) throw new NotFoundError();
        const scope = { studyId: m.studyId, ownerId: m.ownerId };
        const root = await StudyNode.findOne({
          where: { ...scope, id: body.rootNodeId, deletedAt: null },
          attributes: ['id', 'type'],
        });
        if (!root) throw new NotFoundError();
        if (!ROOT_TYPES.has(root.type)) throw new BranchRuleError(BRANCH_ROOT_TYPE_NOT_ALLOWED);
        const rooted = await StudyBranch.count({ where: { ...scope, rootNodeId: root.id } });
        if (rooted > 0) throw new BranchRuleError(BRANCH_EXISTS);

        const branch = await m.createChild(StudyBranch, { rootNodeId: root.id });
        const event = await m.appendEvent({
          eventType: BRANCH_EVENTS.created,
          payload: { branchId: branch.id, rootNodeId: root.id },
        });
        const response: CreateBranchResponse = {
          ...branchFields(branch, []),
          studyId: m.studyId,
          studyRevision,
          lastEventSequence: event.sequence,
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * `PATCH /studies/:studyId/branches/:branchId/members`. `expectedRevision` is the branch's: the
   * study revision never moves, so a membership change never conflicts with a content edit in
   * another tab. Checked in order under the study lock: the branch (404) at that revision (409),
   * then `changeBranchMembers` (404 for any node), then 422 `BRANCH_UNCHANGED` when the net change
   * is empty (the revision bump rolls back with everything else).
   */
  async updateMembers(
    ownerId: string,
    studyId: string,
    branchId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateBranchMembersRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const branch = await m.updateWithExpectedRevision(StudyBranch, {
          id: branchId,
          expectedRevision,
          values: {},
        });
        const change = await changeBranchMembers(m, branch, body);
        if (change.addedNodeIds.length + change.removedNodeIds.length === 0) {
          throw new BranchRuleError(BRANCH_UNCHANGED);
        }
        const event = await m.appendEvent({
          eventType: BRANCH_EVENTS.membersChanged,
          payload: { branchId: branch.id, ...change },
        });
        const response: BranchMutationResponse = {
          ...branchFields(branch, await liveMemberIds(m, branch.id)),
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }
}
