import {
  type AcceptAiSuggestionRequest,
  type AcceptAiSuggestionResponse,
  acceptAiSuggestionResponseSchema,
  type AiConsentResponse,
  aiConsentResponseSchema,
  type AiJobAcceptedResponse,
  aiJobAcceptedResponseSchema,
  type AiJobResponse,
  aiJobResponseSchema,
  type AiSuggestionListResponse,
  aiSuggestionListResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type RejectAiSuggestionRequest,
  type RejectAiSuggestionResponse,
  rejectAiSuggestionResponseSchema,
  type RequestRelationships,
  type UpdateAiConsentRequest,
  type UpdateAiConsentResponse,
  updateAiConsentResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/** AI consent (BIB-40): `GET`/`PUT /v1/me/ai-consent`. */
export const AI_CONSENT_QUERY_KEY = ['me', 'ai-consent'] as const;

export function fetchAiConsent(): Promise<AiConsentResponse> {
  return apiFetch('/me/ai-consent', aiConsentResponseSchema);
}

/**
 * A retry must resend the same body and `idempotencyKey`, so a retry after a lost response
 * replays the change instead of conflicting with the revision it already moved.
 */
export function updateAiConsent(
  body: UpdateAiConsentRequest,
  idempotencyKey: string,
): Promise<UpdateAiConsentResponse> {
  return apiFetch('/me/ai-consent', updateAiConsentResponseSchema, {
    method: 'PUT',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/* AI relationship suggestions (BIB-42). URLs carry opaque ids only. */

const studyAiPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/ai`;

/** Under the study's key, so refreshing a study refreshes its suggestions too. */
export function aiSuggestionsQueryKey(studyId: string, nodeId: string) {
  return ['studies', studyId, 'ai-suggestions', nodeId] as const;
}

/** `POST /studies/:id/ai/relationships` → 202 with the job to poll. */
export function requestRelationships(
  studyId: string,
  body: RequestRelationships,
  idempotencyKey: string,
): Promise<AiJobAcceptedResponse> {
  return apiFetch(`${studyAiPath(studyId)}/relationships`, aiJobAcceptedResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function fetchAiJob(studyId: string, jobId: string): Promise<AiJobResponse> {
  return apiFetch(`${studyAiPath(studyId)}/jobs/${encodeURIComponent(jobId)}`, aiJobResponseSchema);
}

export function listAiSuggestions(
  studyId: string,
  nodeId: string,
): Promise<AiSuggestionListResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/suggestions?nodeId=${encodeURIComponent(nodeId)}`,
    aiSuggestionListResponseSchema,
  );
}

/** `expectedRevision` is the suggestion's; `type` / `note` edit it before accepting. */
export function acceptAiSuggestion(
  studyId: string,
  suggestionId: string,
  body: AcceptAiSuggestionRequest,
  idempotencyKey: string,
): Promise<AcceptAiSuggestionResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/suggestions/${encodeURIComponent(suggestionId)}/accept`,
    acceptAiSuggestionResponseSchema,
    {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

export function rejectAiSuggestion(
  studyId: string,
  suggestionId: string,
  body: RejectAiSuggestionRequest,
  idempotencyKey: string,
): Promise<RejectAiSuggestionResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/suggestions/${encodeURIComponent(suggestionId)}/reject`,
    rejectAiSuggestionResponseSchema,
    {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}
