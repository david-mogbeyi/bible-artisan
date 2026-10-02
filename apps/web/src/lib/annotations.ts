import {
  type AnnotationListResponse,
  annotationListResponseSchema,
  type AnnotationMutationResponse,
  annotationMutationResponseSchema,
  type CreateAnnotationRequest,
  type CreateAnnotationResponse,
  createAnnotationResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type UpdateAnnotationRequest,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Highlight data access (BIB-24). Anchors, quotes and labels travel only in request and response
 * bodies; URLs carry opaque ids alone (PRD section 9, NFR-PRIV-001). Nothing here touches browser
 * storage. Every mutation takes an Idempotency-Key that a retry resends with the identical body.
 */

const annotationsPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/annotations`;
const annotationPath = (studyId: string, annotationId: string) =>
  `${annotationsPath(studyId)}/${encodeURIComponent(annotationId)}`;

/** Under the study's key, so refreshing a study refreshes its highlights too. */
export function annotationsQueryKey(studyId: string, referenceId: string) {
  return ['studies', studyId, 'annotations', referenceId] as const;
}

export function annotationListsKey(studyId: string) {
  return ['studies', studyId, 'annotations'] as const;
}

/** The study's highlights on the chapter the reader shows for `referenceId`. */
export function listAnnotations(
  studyId: string,
  referenceId: string,
): Promise<AnnotationListResponse> {
  const params = new URLSearchParams({ referenceId });
  return apiFetch(`${annotationsPath(studyId)}?${params.toString()}`, annotationListResponseSchema);
}

export function createAnnotation(
  studyId: string,
  body: CreateAnnotationRequest,
  idempotencyKey: string,
): Promise<CreateAnnotationResponse> {
  return apiFetch(annotationsPath(studyId), createAnnotationResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function updateAnnotation(
  studyId: string,
  annotationId: string,
  body: UpdateAnnotationRequest,
  idempotencyKey: string,
): Promise<AnnotationMutationResponse> {
  return apiFetch(annotationPath(studyId, annotationId), annotationMutationResponseSchema, {
    method: 'PATCH',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function deleteAnnotation(
  studyId: string,
  annotationId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<AnnotationMutationResponse> {
  return apiFetch(annotationPath(studyId, annotationId), annotationMutationResponseSchema, {
    method: 'DELETE',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify({ expectedRevision }),
  });
}
