import {
  type CreateStudyRequest,
  type CreateStudyResponse,
  createStudyResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type StudyResponse,
  studyResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Study data access (BIB-19). The title, question and passage travel only in request bodies;
 * URLs carry the opaque study id alone (PRD section 9, NFR-PRIV-001).
 */

/**
 * `POST /v1/studies`. `idempotencyKey` must be the same for every retry of the same draft, so a
 * retry after a lost response replays the original study instead of creating a second one.
 */
export function createStudy(
  body: CreateStudyRequest,
  idempotencyKey: string,
): Promise<CreateStudyResponse> {
  return apiFetch('/studies', createStudyResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function studyQueryKey(studyId: string) {
  return ['studies', studyId] as const;
}

export function fetchStudy(studyId: string): Promise<StudyResponse> {
  return apiFetch(`/studies/${encodeURIComponent(studyId)}`, studyResponseSchema);
}

export function studyHref(studyId: string): string {
  return `/studies/${encodeURIComponent(studyId)}`;
}
