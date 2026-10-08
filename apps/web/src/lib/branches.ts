import {
  type Branch,
  type BranchMutationResponse,
  branchMutationResponseSchema,
  type CreateBranchRequest,
  type CreateBranchResponse,
  createBranchResponseSchema,
  type GraphResponse,
  IDEMPOTENCY_KEY_HEADER,
  type NodeSummary,
  type UpdateBranchMembersRequest,
} from '@bible-artisan/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';
import { graphQueryKey } from './graph';
import { nodeOptionText } from './nodes';

/**
 * Branch data access (BIB-60). Branches are read from the graph snapshot (`GET /graph`), never a
 * fetch of their own. Requests and responses carry ids and integers only; a branch's name exists
 * only in the DOM ("Branch: " + its root's label), never in a URL, browser storage or a request.
 */

const branchesPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/branches`;

/** `POST /studies/:id/branches`. `expectedRevision` is the study's. */
export function createBranch(
  studyId: string,
  body: CreateBranchRequest,
  idempotencyKey: string,
): Promise<CreateBranchResponse> {
  return apiFetch(branchesPath(studyId), createBranchResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `PATCH /studies/:id/branches/:branchId/members`. `expectedRevision` is the branch's. */
export function updateBranchMembers(
  studyId: string,
  branchId: string,
  body: UpdateBranchMembersRequest,
  idempotencyKey: string,
): Promise<BranchMutationResponse> {
  return apiFetch(
    `${branchesPath(studyId)}/${encodeURIComponent(branchId)}/members`,
    branchMutationResponseSchema,
    {
      method: 'PATCH',
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

/** A branch's nodes: its root, then its live members. */
export function branchNodeIds(branch: Pick<Branch, 'rootNodeId' | 'memberNodeIds'>): string[] {
  return [branch.rootNodeId, ...branch.memberNodeIds];
}

/** "Branch: Question: Can conscience be wrong?": a branch is named by its root. */
export function branchLabel(
  branch: Pick<Branch, 'rootNodeId'>,
  nodesById: ReadonlyMap<string, NodeSummary>,
): string {
  const root = nodesById.get(branch.rootNodeId);
  return `Branch: ${root ? nodeOptionText(root) : 'a node no longer in this study'}`;
}

/** Whether `nodeId` is in `branch` (its root or a member). */
export function inBranch(branch: Pick<Branch, 'rootNodeId' | 'memberNodeIds'>, nodeId: string) {
  return branch.rootNodeId === nodeId || branch.memberNodeIds.includes(nodeId);
}

/**
 * Puts a branch the server just acknowledged into the cached snapshot (a new one goes last, as
 * the snapshot orders branches oldest first), so every view shows it before the refetch lands.
 */
export function storeBranch(queryClient: QueryClient, studyId: string, branch: Branch): void {
  queryClient.setQueryData<GraphResponse>(graphQueryKey(studyId), (old) => {
    if (!old) return old;
    const fresh: Branch = {
      id: branch.id,
      rootNodeId: branch.rootNodeId,
      memberNodeIds: branch.memberNodeIds,
      revision: branch.revision,
      createdAt: branch.createdAt,
    };
    const known = old.branches.some((b) => b.id === branch.id);
    return {
      ...old,
      branches: known
        ? old.branches.map((b) => (b.id === branch.id && b.revision <= fresh.revision ? fresh : b))
        : [...old.branches, fresh],
    };
  });
}
