import { z } from 'zod';
import { expectedRevisionSchema } from './mutation';

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

/** The AI capabilities that exist so far. Later tickets add relationships, tensions, … */
export const AI_CAPABILITIES = ['summary'] as const;
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

/** 422 codes: the request cannot run in the account's or study's current AI state. */
export type AiRuleErrorCode =
  typeof AI_CONSENT_REQUIRED | typeof AI_DISABLED_FOR_STUDY | typeof AI_CONSENT_VERSION_MISMATCH;

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

/** The summary capability's output, version 0 (BIB-43 replaces it with the section 17 schema). */
export const summaryOutputV0Schema = z.strictObject({
  overview: z.string().min(1).max(2000),
  /** Ids of manifest entries the overview draws on. Every id must be in the manifest. */
  citedIds: z.array(z.uuid()).max(30),
});
export type SummaryOutputV0 = z.infer<typeof summaryOutputV0Schema>;

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
      output: summaryOutputV0Schema,
      createdAt: z.iso.datetime(),
    })
    .nullable(),
});
export type AiJobResponse = z.infer<typeof aiJobResponseSchema>;
