import {
  type CreateStudyRequest,
  type CreateStudyResponse,
  createStudyResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type StudyListResponse,
  studyListResponseSchema,
  type StudyResponse,
  studyResponseSchema,
  type StudySort,
  type UpdateStudyRequest,
  type UpdateStudyResponse,
  updateStudyResponseSchema,
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

/**
 * `PATCH /v1/studies/:studyId` (BIB-20). A retry must resend the frozen request: the same body
 * (with its original `expectedRevision`) and the same `idempotencyKey`, so a retry after a lost
 * response replays the original edit instead of applying it again on a revision the edit itself
 * already moved.
 */
export function updateStudy(
  studyId: string,
  body: UpdateStudyRequest,
  idempotencyKey: string,
): Promise<UpdateStudyResponse> {
  return apiFetch(`/studies/${encodeURIComponent(studyId)}`, updateStudyResponseSchema, {
    method: 'PATCH',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function studyHref(studyId: string): string {
  return `/studies/${encodeURIComponent(studyId)}`;
}

/** What the library asks for (BIB-21). `q` and the tag id stay in memory: never in the page URL. */
export interface LibraryRequest {
  q?: string;
  tagId?: string;
  sort: StudySort;
  limit?: number;
}

/** Under `['studies']`, so anything that refreshes studies refreshes the library too. */
export function libraryQueryKey(request: LibraryRequest) {
  return ['studies', 'library', request] as const;
}

/**
 * `GET /v1/studies`: one page of the signed-in user's own studies, pinned first. The search text
 * travels only in this API request's query string (PRD section 24), which the API never logs;
 * the page's own URL never carries it (PRD section 9).
 */
export function listStudies(
  request: LibraryRequest,
  cursor: string | null,
): Promise<StudyListResponse> {
  const params = new URLSearchParams({ sort: request.sort });
  if (request.q !== undefined) params.set('q', request.q);
  if (request.tagId !== undefined) params.set('tag', request.tagId);
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  if (cursor !== null) params.set('cursor', cursor);
  return apiFetch(`/studies?${params.toString()}`, studyListResponseSchema);
}
