'use client';

import {
  BRANCH_ERROR_CODES,
  BRANCH_ERROR_MESSAGES,
  BRANCH_UNCHANGED,
  type BranchErrorCode,
  type BranchMutationResponse,
  type UpdateBranchMembersRequest,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  codeOf,
  isLifecycle,
  type Outcome,
  type Problem,
  statusOf,
  useFrozenRequest,
} from '@/components/nodes/relationship-controls';
import { storeBranch, updateBranchMembers } from '@/lib/branches';
import { invalidateGraph } from '@/lib/graph';
import { invalidateLibrary } from '@/lib/studies';

/** Branch copy shared by node detail's Branches group and the canvas toolbar (BIB-60). */
export const BRANCH_COPY = {
  started: 'Branch started.',
  conflict: 'This branch changed. Try again.',
  studyConflict: 'The study changed — press Start a branch here again.',
  gone: 'That node or branch is no longer in this study.',
  unknown: "Couldn't confirm the change was saved. Retry won't save it twice.",
  failed: "Couldn't change the branch.",
  loading: 'Loading branches…',
  loadFailed: "Couldn't load the branches.",
  none: 'No branches yet.',
  notInAny: 'Not in any branch.',
  toolbarEmpty: 'No branches yet. Start one from a question or passage in node detail.',
} as const;

const BRANCH_CODES: ReadonlySet<string> = new Set(BRANCH_ERROR_CODES);

/** A branch rule's fixed message, as a sentence (never the server's text). */
export function branchRuleText(code: string | undefined): string | null {
  return code !== undefined && BRANCH_CODES.has(code)
    ? `${BRANCH_ERROR_MESSAGES[code as BranchErrorCode]}.`
    : null;
}

interface MembersCall {
  branchId: string;
  body: UpdateBranchMembersRequest;
}

/**
 * One membership change at a time for a study (`PATCH /branches/:id/members`): the frozen body
 * and Idempotency-Key are resent verbatim by `retry` after an unknown outcome. A 200 puts the
 * acknowledged branch into the cached snapshot and refetches it; a 409, a 404 or
 * `BRANCH_UNCHANGED` refetches the snapshot so every view shows the server's state.
 */
export function useBranchMembers(studyId: string) {
  const queryClient = useQueryClient();
  const request = useFrozenRequest(({ branchId, body }: MembersCall, key: string) =>
    updateBranchMembers(studyId, branchId, body, key),
  );

  async function settle(
    pending: Promise<Outcome<BranchMutationResponse>> | null,
  ): Promise<Outcome<BranchMutationResponse> | null> {
    const outcome = await pending;
    if (!outcome) return null;
    if (outcome.ok) {
      storeBranch(queryClient, studyId, outcome.value);
      void invalidateGraph(queryClient, studyId);
      // Membership is study activity: the library's "recent" order moves.
      void invalidateLibrary(queryClient);
    } else if (!outcome.unknown && !isLifecycle(outcome.error)) {
      void invalidateGraph(queryClient, studyId);
    }
    return outcome;
  }

  return {
    pending: request.pending,
    send: (branchId: string, body: UpdateBranchMembersRequest) =>
      settle(request.send({ branchId, body })),
    retry: () => settle(request.retry()),
  };
}

/**
 * What a failed membership change says. `locked` hands over to the section's read-only state;
 * `unchanged` is `BRANCH_UNCHANGED`, which each caller treats its own way.
 */
export function membersProblem(
  outcome: Extract<Outcome<unknown>, { ok: false }>,
): Problem | 'locked' | 'unchanged' {
  const { error } = outcome;
  if (outcome.unknown) return { text: BRANCH_COPY.unknown, retry: true };
  if (isLifecycle(error)) return 'locked';
  if (statusOf(error) === 409) return { text: BRANCH_COPY.conflict };
  if (statusOf(error) === 404) return { text: BRANCH_COPY.gone };
  if (codeOf(error) === BRANCH_UNCHANGED) return 'unchanged';
  return { text: branchRuleText(codeOf(error)) ?? BRANCH_COPY.failed };
}
