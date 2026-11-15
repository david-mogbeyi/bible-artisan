import { z } from 'zod';
import { EDGE_TYPES, edgeNoteSchema } from './edge';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';

/**
 * AI consent, settings and jobs (BIB-39, BIB-40; PRD sections 16, 22, 24, 25, 29, 38).
 *
 * AI is optional and off by default. Private study text reaches a provider only when all of these
 * hold: the deployment has an approved provider configured (`providerAvailable`), the user has
 * opted in to the current consent version, and the study has not turned AI off. Every AI request
 * is a background job: the request returns 202 at once and the client polls the job.
 */

/**
 * The consent text version. Bump it whenever what is sent, the provider, its retention/training
 * terms or the purpose changes materially: every user then has to consent again (PRD section 29,
 * "require renewed consent for materially changed handling").
 */
export const AI_CONSENT_VERSION = '2026-11-15.1';

/** What the consent screen states before AI can be turned on (PRD section 29). Fixed copy. */
export const AI_CONSENT_COPY = {
  purpose:
    'AI features summarize your study, suggest relationships and point out open questions. They are optional, and every AI result stays a suggestion until you accept it.',
  whatIsSent:
    'Only the parts of one study that a request needs: its question, the nodes, conclusions and note excerpts selected for that request, and recent study activity. Never your email, your name or your other studies.',
  provider:
    'Requests go to the AI provider named below, under terms that prohibit training on your content. AI stays off for everyone until those terms are verified.',
  revocation:
    'You can turn AI off at any time, for your account or for one study. Turning it off cancels waiting requests and discards results that have not arrived yet. Content already sent to the provider cannot be recalled; it is handled under the provider terms above.',
} as const;

/**
 * The AI capabilities. BIB-43: `summary` produces the section 17 living summary. BIB-44:
 * `tensions` (proposed tensions between two claims) and `questions` (existing open questions plus
 * proposed new ones). BIB-45: `passages` (verified next passages to investigate).
 */
export const AI_CAPABILITIES = [
  'summary',
  'relationships',
  'tensions',
  'questions',
  'passages',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const AI_JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AiJobState = (typeof AI_JOB_STATES)[number];

/**
 * Why a job ended without a result. Fixed codes, never provider text (NFR-PRIV-001).
 * `retryable` on the job says whether asking again can help.
 */
export const AI_JOB_ERROR_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSED',
  'PROVIDER_ERROR',
  'VALIDATION_FAILED',
  'CONTEXT_BUDGET_EXCEEDED',
  'LEASE_EXPIRED',
  'SPEND_CAP_REACHED',
  'AI_UNAVAILABLE',
  'CONSENT_REVOKED',
  'AI_DISABLED_FOR_STUDY',
  'STUDY_UNAVAILABLE',
] as const;
export type AiJobErrorCode = (typeof AI_JOB_ERROR_CODES)[number];

/** Job errors where a new request may succeed (transient provider trouble, a crashed worker). */
export const RETRYABLE_AI_JOB_ERRORS: ReadonlySet<AiJobErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'VALIDATION_FAILED',
  'LEASE_EXPIRED',
]);

/** Request errors (PRD section 24). */
export const AI_CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';
export const AI_DISABLED_FOR_STUDY = 'AI_DISABLED_FOR_STUDY';
export const AI_CONSENT_VERSION_MISMATCH = 'AI_CONSENT_VERSION_MISMATCH';
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_QUOTA_EXCEEDED = 'AI_QUOTA_EXCEEDED';
export const AI_SPEND_CAP_REACHED = 'AI_SPEND_CAP_REACHED';
/** BIB-42: the suggestion was already rejected (or replaced by a newer request). */
export const AI_SUGGESTION_NOT_PROPOSED = 'AI_SUGGESTION_NOT_PROPOSED';
/** BIB-42: a node the suggestion connects changed or was removed since it was proposed. */
export const AI_SUGGESTION_EXPIRED = 'AI_SUGGESTION_EXPIRED';

/** 422 codes: the request cannot run in the account's or study's current AI state. */
export type AiRuleErrorCode =
  | typeof AI_CONSENT_REQUIRED
  | typeof AI_DISABLED_FOR_STUDY
  | typeof AI_CONSENT_VERSION_MISMATCH
  | typeof AI_SUGGESTION_NOT_PROPOSED
  | typeof AI_SUGGESTION_EXPIRED;

export const AI_ERROR_MESSAGES: Record<
  AiRuleErrorCode | typeof AI_UNAVAILABLE | typeof AI_QUOTA_EXCEEDED | typeof AI_SPEND_CAP_REACHED,
  string
> = {
  AI_CONSENT_REQUIRED: 'Turn on AI features in your settings to use this',
  AI_DISABLED_FOR_STUDY: 'AI features are turned off for this study',
  AI_CONSENT_VERSION_MISMATCH: 'The AI terms have changed. Review them again to turn AI on',
  AI_UNAVAILABLE: 'AI features are not available right now',
  AI_QUOTA_EXCEEDED: 'You have reached the AI request limit. Try again later',
  AI_SPEND_CAP_REACHED: 'AI features are paused for now. Your study is unaffected',
  AI_SUGGESTION_NOT_PROPOSED: 'This suggestion is no longer open',
  AI_SUGGESTION_EXPIRED:
    'An item this suggestion connects changed since it was suggested. Ask for a new suggestion',
};

/** PRD section 25 limits. */
export const AI_LIMITS = {
  /** Jobs running at once for one study. */
  runningPerStudy: 1,
  /** Jobs running at once for one user. */
  runningPerUser: 2,
  /** User-triggered requests per rolling hour. */
  userRequestsPerHour: 20,
  /** All requests per rolling day. */
  requestsPerDay: 50,
  /** Automatic summaries per rolling day. */
  automaticSummariesPerDay: 30,
} as const;

/** `GET /v1/me/ai-consent`. */
export const aiConsentResponseSchema = z.object({
  /** The account switch: true only with consent to `consentVersion`. */
  enabled: z.boolean(),
  /** The version the user last agreed to, or null if never. */
  consentVersion: z.string().nullable(),
  consentedAt: z.iso.datetime().nullable(),
  /** The version the app shows now (`AI_CONSENT_VERSION`). */
  currentConsentVersion: z.string(),
  /** True when the user consented to an older version: AI stays off until they agree again. */
  needsRenewal: z.boolean(),
  /** Revision of the account's AI settings, for `expectedRevision`. */
  revision: z.number().int().positive(),
  /** Whether this deployment has an approved provider configured at all. */
  providerAvailable: z.boolean(),
  /** The provider and model requests go to, when available. */
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Requests left in the rolling windows (PRD section 25). */
  remaining: z.object({
    thisHour: z.number().int().nonnegative(),
    today: z.number().int().nonnegative(),
  }),
});
export type AiConsentResponse = z.infer<typeof aiConsentResponseSchema>;

/**
 * `PUT /v1/me/ai-consent`. Turning AI on needs `consentVersion` equal to the current version (the
 * user saw that text). Turning it off cancels the user's waiting and running jobs.
 */
export const updateAiConsentRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  enabled: z.boolean(),
  consentVersion: z.string().min(1).max(64).optional(),
});
export type UpdateAiConsentRequest = z.infer<typeof updateAiConsentRequestSchema>;

/** `PUT /v1/me/ai-consent` 200: the new state and how many jobs the change cancelled. */
export const updateAiConsentResponseSchema = z.object({
  enabled: z.boolean(),
  consentVersion: z.string().nullable(),
  revision: z.number().int().positive(),
  cancelledJobCount: z.number().int().nonnegative(),
});
export type UpdateAiConsentResponse = z.infer<typeof updateAiConsentResponseSchema>;

/** `GET /v1/studies/:studyId/ai/settings`: the study's own AI switch (on unless turned off). */
export const studyAiSettingsResponseSchema = z.object({
  aiEnabled: z.boolean(),
  /** Revision of this study's AI settings row (1 before the first change). */
  revision: z.number().int().positive(),
});
export type StudyAiSettingsResponse = z.infer<typeof studyAiSettingsResponseSchema>;

/** `PUT /v1/studies/:studyId/ai/settings`. The study switch overrides the account switch. */
export const updateStudyAiSettingsRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  aiEnabled: z.boolean(),
});
export type UpdateStudyAiSettingsRequest = z.infer<typeof updateStudyAiSettingsRequestSchema>;

export const updateStudyAiSettingsResponseSchema = z.object({
  aiEnabled: z.boolean(),
  revision: z.number().int().positive(),
  cancelledJobCount: z.number().int().nonnegative(),
  lastEventSequence: z.string(),
});
export type UpdateStudyAiSettingsResponse = z.infer<typeof updateStudyAiSettingsResponseSchema>;

/** `POST /v1/studies/:studyId/ai/summary` 202 (PRD section 24). */
export const aiJobAcceptedResponseSchema = z.object({
  jobId: z.uuid(),
  /** The study content revision the job will read. */
  basisRevision: z.number().int().positive(),
  statusUrl: z.string(),
  /** `existing`: an equivalent job was already waiting or running, so no new request was used. */
  outcome: z.enum(['queued', 'existing']),
});
export type AiJobAcceptedResponse = z.infer<typeof aiJobAcceptedResponseSchema>;

/** What the context manifest says about one job's input (no private text). */
export const aiContextSummarySchema = z.object({
  tokenBudget: z.number().int().positive(),
  tokenCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  omittedCount: z.number().int().nonnegative(),
  /** Fixed sentences about what was left out, e.g. "3 notes were left out to fit the budget". */
  coverageWarnings: z.array(z.string()),
});
export type AiContextSummary = z.infer<typeof aiContextSummarySchema>;

/**
 * The summary capability's output, version 0 (BIB-39). BIB-43 replaced it with the section 17
 * StudySummary v1 (`ai-insights.ts`); kept so results stored before then still read.
 */
export const summaryOutputV0Schema = z.strictObject({
  overview: z.string().min(1).max(2000),
  /** Ids of manifest entries the overview draws on. Every id must be in the manifest. */
  citedIds: z.array(z.uuid()).max(30),
});
export type SummaryOutputV0 = z.infer<typeof summaryOutputV0Schema>;

/**
 * Relationship detection (BIB-42; PRD section 16 "Relationship detection"). The model's raw
 * answer: zero to three proposed edges between the two requested nodes, each with a rationale and
 * evidence that cites context ids (and optionally quotes their stored text exactly). Strict: an
 * extra key (a status, an "established" flag, a tool call) fails validation (BIB-41).
 */
export const MAX_RELATIONSHIP_PROPOSALS = 3;
export const MAX_PROPOSAL_RATIONALE_LENGTH = 600;
export const MAX_EVIDENCE_QUOTE_LENGTH = 300;

export const relationshipEvidenceSchema = z.strictObject({
  /** A context id: one of the two nodes, or another node or note in the context. */
  id: z.uuid(),
  /** Words copied exactly from that item's stored text (Scripture: the corpus text). */
  quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_LENGTH).optional(),
});
export type RelationshipEvidence = z.infer<typeof relationshipEvidenceSchema>;

export const relationshipProposalSchema = z.strictObject({
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.enum(EDGE_TYPES),
  rationale: z.string().min(1).max(MAX_PROPOSAL_RATIONALE_LENGTH),
  evidence: z.array(relationshipEvidenceSchema).min(1).max(4),
});
export type RelationshipProposal = z.infer<typeof relationshipProposalSchema>;

export const relationshipsOutputSchema = z.strictObject({
  proposals: z.array(relationshipProposalSchema).max(MAX_RELATIONSHIP_PROPOSALS),
});
export type RelationshipsOutput = z.infer<typeof relationshipsOutputSchema>;

/**
 * What a finished relationships job reports: the suggestions it stored, and how many valid
 * proposals were suppressed (rejected before, or already an edge) or dropped by validation.
 */
export const relationshipsJobOutputSchema = z.strictObject({
  suggestionIds: z.array(z.uuid()),
  suppressedCount: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
});
export type RelationshipsJobOutput = z.infer<typeof relationshipsJobOutputSchema>;

/**
 * `POST /v1/studies/:studyId/ai/relationships` → 202 (an AI job, like the summary). Two different
 * live nodes of the study. `regenerate: true` asks again including proposals rejected before
 * (FR-AI-004 "until explicit regeneration").
 */
export const requestRelationshipsSchema = z
  .strictObject({
    sourceNodeId: z.uuid().transform((id) => id.toLowerCase()),
    targetNodeId: z.uuid().transform((id) => id.toLowerCase()),
    regenerate: z.boolean().optional(),
  })
  .refine((body) => body.sourceNodeId !== body.targetNodeId, {
    path: ['targetNodeId'],
    message: 'Choose two different nodes',
  });
export type RequestRelationships = z.input<typeof requestRelationshipsSchema>;

export const AI_SUGGESTION_STATUSES = ['proposed', 'accepted', 'rejected', 'expired'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

/** One AI relationship proposal as the client reads it (`GET /ai/suggestions`). */
export const aiSuggestionSchema = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  /**
   * `relationships` (BIB-42) or `tensions` (BIB-44: a proposed tension between two claims;
   * accepting it adds the `contradicts` or `qualifies` relationship, never a status change).
   */
  capability: z.enum(['relationships', 'tensions']),
  /** `expired`: a connected node changed or was removed since; it can no longer be accepted. */
  status: z.enum(AI_SUGGESTION_STATUSES),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.enum(EDGE_TYPES),
  rationale: z.string(),
  /** BIB-44: a tension's interpretive caveat (null for relationships). */
  caveat: z.string().nullable(),
  evidence: z.array(z.object({ id: z.uuid(), quote: z.string().nullable() })),
  /** Revision of the suggestion, for accept/reject `expectedRevision`. */
  revision: z.number().int().positive(),
  basisRevision: z.number().int().positive(),
  modelId: z.string(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  /** The edge created (or found) when accepted. */
  acceptedEdgeId: z.uuid().nullable(),
});
export type AiSuggestion = z.infer<typeof aiSuggestionSchema>;

/**
 * `GET /v1/studies/:studyId/ai/suggestions?nodeId=`: open suggestions touching that node.
 * `?capability=tensions` (BIB-44): the study's open tension suggestions.
 */
export const listAiSuggestionsQuerySchema = z.union([
  z.strictObject({ nodeId: z.string().max(64) }),
  z.strictObject({ capability: z.literal('tensions') }),
]);
export const aiSuggestionListResponseSchema = z.object({ items: z.array(aiSuggestionSchema) });
export type AiSuggestionListResponse = z.infer<typeof aiSuggestionListResponseSchema>;

/**
 * `POST /v1/studies/:studyId/ai/suggestions/:id/accept`. `expectedRevision` is the suggestion's.
 * `type` and `note` edit the proposal before accepting (PRD section 16 "edit before accepting");
 * the endpoints and direction stay the proposal's.
 */
export const acceptAiSuggestionRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  type: z.enum(EDGE_TYPES).optional(),
  note: edgeNoteSchema.optional(),
});
export type AcceptAiSuggestionRequest = z.input<typeof acceptAiSuggestionRequestSchema>;

/** `POST /v1/studies/:studyId/ai/suggestions/:id/reject`. */
export const rejectAiSuggestionRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
});
export type RejectAiSuggestionRequest = z.input<typeof rejectAiSuggestionRequestSchema>;

/**
 * 200 from accept. `created`: a new AI-origin edge; `existing`: the same live edge already
 * existed (made by you, or this suggestion was already accepted): no second edge.
 */
export const acceptAiSuggestionResponseSchema = z.object({
  suggestionId: z.uuid(),
  status: z.literal('accepted'),
  revision: z.number().int().positive(),
  outcome: z.enum(['created', 'existing']),
  edge: z.object({
    id: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    type: z.enum(EDGE_TYPES),
    origin: z.enum(['user', 'ai']),
    suggestionId: z.uuid().nullable(),
    revision: z.number().int().positive(),
  }),
  lastEventSequence: eventSequenceSchema.nullable(),
});
export type AcceptAiSuggestionResponse = z.infer<typeof acceptAiSuggestionResponseSchema>;

export const rejectAiSuggestionResponseSchema = z.object({
  suggestionId: z.uuid(),
  status: z.literal('rejected'),
  revision: z.number().int().positive(),
  lastEventSequence: eventSequenceSchema,
});
export type RejectAiSuggestionResponse = z.infer<typeof rejectAiSuggestionResponseSchema>;

/**
 * What a finished summary job reports (BIB-43): the StudySummary revision it stored, whether it
 * became the current summary (false: its basis was no longer the study's content revision, so it
 * is kept as a historical artifact), and how many generated items validation dropped.
 */
export const summaryJobOutputSchema = z.strictObject({
  summaryId: z.uuid(),
  current: z.boolean(),
  droppedCount: z.number().int().nonnegative(),
});
export type SummaryJobOutput = z.infer<typeof summaryJobOutputSchema>;

/**
 * What a finished open-questions job reports (BIB-44): the existing open questions it pointed to
 * (ids only; their statuses are untouched) and the proposals it stored.
 */
export const questionsJobOutputSchema = z.strictObject({
  existingOpenQuestionIds: z.array(z.uuid()),
  suggestionIds: z.array(z.uuid()),
  suppressedCount: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
});
export type QuestionsJobOutput = z.infer<typeof questionsJobOutputSchema>;

/** `GET /v1/studies/:studyId/ai/jobs/:jobId`. */
export const aiJobResponseSchema = z.object({
  jobId: z.uuid(),
  studyId: z.uuid(),
  capability: z.enum(AI_CAPABILITIES),
  state: z.enum(AI_JOB_STATES),
  basisRevision: z.number().int().positive(),
  /** The study's content revision now. */
  currentRevision: z.number().int().positive(),
  /** True when the study changed after the job's basis: the result is historical, not current. */
  stale: z.boolean(),
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.enum(AI_JOB_ERROR_CODES).nullable(),
  /** For a failed or cancelled job: whether requesting again can help. */
  retryable: z.boolean(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  context: aiContextSummarySchema.nullable(),
  result: z
    .object({
      id: z.uuid(),
      modelId: z.string(),
      promptVersion: z.string(),
      output: z.union([
        summaryJobOutputSchema,
        relationshipsJobOutputSchema,
        questionsJobOutputSchema,
        summaryOutputV0Schema,
      ]),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
});
export type AiJobResponse = z.infer<typeof aiJobResponseSchema>;
