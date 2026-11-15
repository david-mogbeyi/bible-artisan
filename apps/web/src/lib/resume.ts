import {
  IDEMPOTENCY_KEY_HEADER,
  type ResumeResponse,
  resumeResponseSchema,
  type ResumeTarget,
  type SaveViewStateRequest,
  type SaveViewStateResponse,
  saveViewStateResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';
import { bibleHref } from './bible';
import { studyHref } from './studies';

/**
 * Deterministic resume (BIB-34). URLs carry opaque ids only; the question, passage and conclusion
 * text travel in response bodies.
 */

const studyPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}`;

/** Under the study's key, so refreshing a study refreshes its resume card too. */
export function resumeQueryKey(studyId: string) {
  return ['studies', studyId, 'resume'] as const;
}

export function fetchResume(studyId: string): Promise<ResumeResponse> {
  return apiFetch(`${studyPath(studyId)}/resume`, resumeResponseSchema);
}

/** `PATCH /studies/:id/view-state`; `expectedRevision` is the **view** revision. */
export function saveViewState(
  studyId: string,
  body: SaveViewStateRequest,
  idempotencyKey: string,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<SaveViewStateResponse> {
  return apiFetch(`${studyPath(studyId)}/view-state`, saveViewStateResponseSchema, {
    method: 'PATCH',
    keepalive,
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** A study page link that selects a node and shows its branch (opaque ids only). */
export function studyContextHref(
  studyId: string,
  nodeId: string | null,
  branchId: string | null,
): string {
  const params = new URLSearchParams();
  if (nodeId) params.set('node', nodeId);
  if (branchId) params.set('branch', branchId);
  const query = params.toString();
  return query ? `${studyHref(studyId)}?${query}` : studyHref(studyId);
}

/** Where "Resume from last point" goes (the server already chose the surviving context). */
export function resumeHref(studyId: string, target: ResumeTarget): string {
  if (target.kind === 'passage' && target.referenceId) {
    return bibleHref(target.referenceId, studyId);
  }
  return studyContextHref(studyId, target.nodeId, target.branchId);
}
