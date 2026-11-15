import {
  type AcceptAiProposalRequest,
  type AcceptAiProposalResponse,
  acceptAiProposalResponseSchema,
  type AcceptAiSuggestionRequest,
  type AcceptAiSuggestionResponse,
  acceptAiSuggestionResponseSchema,
  type AiConsentResponse,
  aiConsentResponseSchema,
  type AiJobAcceptedResponse,
  aiJobAcceptedResponseSchema,
  type AiJobResponse,
  aiJobResponseSchema,
  type AiProposalCapability,
  type AiProposalListResponse,
  aiProposalListResponseSchema,
  type AiSuggestionListResponse,
  aiSuggestionListResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ReasoningPathResponse,
  reasoningPathResponseSchema,
  type RejectAiProposalRequest,
  type RejectAiProposalResponse,
  rejectAiProposalResponseSchema,
  type RejectAiSuggestionRequest,
  type RejectAiSuggestionResponse,
  rejectAiSuggestionResponseSchema,
  type RequestAiInsight,
  type RequestRelationships,
  type StudySummaryResponse,
  studySummaryResponseSchema,
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

/* BIB-43: the living study summary. */

export function studySummaryQueryKey(studyId: string) {
  return ['studies', studyId, 'summary'] as const;
}

export function fetchStudySummary(studyId: string): Promise<StudySummaryResponse> {
  return apiFetch(`/studies/${encodeURIComponent(studyId)}/summary`, studySummaryResponseSchema);
}

/** `POST /studies/:id/ai/summary` → 202 (a manual Generate / Regenerate). */
export function requestStudySummary(
  studyId: string,
  idempotencyKey: string,
): Promise<AiJobAcceptedResponse> {
  return apiFetch(`${studyAiPath(studyId)}/summary`, aiJobAcceptedResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
  });
}

/* BIB-44 / BIB-45: tensions, open questions and passages. */

export type InsightCapability = 'tensions' | 'questions' | 'passages';

export function requestInsight(
  studyId: string,
  capability: InsightCapability,
  body: RequestAiInsight,
  idempotencyKey: string,
): Promise<AiJobAcceptedResponse> {
  return apiFetch(`${studyAiPath(studyId)}/${capability}`, aiJobAcceptedResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function insightQueryKey(studyId: string, capability: InsightCapability) {
  return ['studies', studyId, 'ai-insights', capability] as const;
}

export function listTensions(studyId: string): Promise<AiSuggestionListResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/suggestions?capability=tensions`,
    aiSuggestionListResponseSchema,
  );
}

export function listProposals(
  studyId: string,
  capability: AiProposalCapability,
): Promise<AiProposalListResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/proposals?capability=${capability}`,
    aiProposalListResponseSchema,
  );
}

export function acceptProposal(
  studyId: string,
  proposalId: string,
  body: AcceptAiProposalRequest,
  idempotencyKey: string,
): Promise<AcceptAiProposalResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/proposals/${encodeURIComponent(proposalId)}/accept`,
    acceptAiProposalResponseSchema,
    {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

export function rejectProposal(
  studyId: string,
  proposalId: string,
  body: RejectAiProposalRequest,
  idempotencyKey: string,
): Promise<RejectAiProposalResponse> {
  return apiFetch(
    `${studyAiPath(studyId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
    rejectAiProposalResponseSchema,
    {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}

/* BIB-45: the deterministic reasoning path (no AI). */

export function reasoningQueryKey(studyId: string, nodeId: string) {
  return ['studies', studyId, 'nodes', nodeId, 'reasoning'] as const;
}

export function fetchReasoning(studyId: string, nodeId: string): Promise<ReasoningPathResponse> {
  return apiFetch(
    `/studies/${encodeURIComponent(studyId)}/nodes/${encodeURIComponent(nodeId)}/reasoning`,
    reasoningPathResponseSchema,
  );
}
