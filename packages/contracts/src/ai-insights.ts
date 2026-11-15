import { z } from 'zod';
import { AI_JOB_ERROR_CODES, AI_SUGGESTION_STATUSES, MAX_EVIDENCE_QUOTE_LENGTH } from './ai';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { CONCLUSION_STATUSES } from './node';
import { MAX_QUESTION_LENGTH, QUESTION_STATUSES } from './study';
import { userTextSchema } from './user-text';

/**
 * AI study insights (PRD sections 16, 17, 18, 24, 25):
 * - BIB-43: the living StudySummary, contract version 1 (section 17).
 * - BIB-44: tension and open-question proposals.
 * - BIB-45: verified next-passage proposals and the deterministic reasoning path of a node.
 *
 * Every generated item is a derived artifact: it never changes a node, a status or a conclusion.
 */

/* ------------------------------------------------------------------------------------------ */
/* Shared model output pieces (what the provider must answer; strict, BIB-41)                 */
/* ------------------------------------------------------------------------------------------ */

/** Section 17 attribution of one generated item. */
export const SUMMARY_ATTRIBUTIONS = [
  'user_statement',
  'ai_synthesis',
  'source_interpretation',
] as const;
export type SummaryAttribution = (typeof SUMMARY_ATTRIBUTIONS)[number];

/** One piece of evidence a model cites: a context id, optionally with exact stored words. */
export const modelEvidenceSchema = z.strictObject({
  id: z.uuid(),
  quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_LENGTH).optional(),
});

export const MAX_SUMMARY_ITEM_LENGTH = 600;
export const MAX_SUMMARY_ITEMS_PER_SECTION = 8;

/** One generated summary item as the model answers it. */
export const summaryModelItemSchema = z.strictObject({
  text: z.string().min(1).max(MAX_SUMMARY_ITEM_LENGTH),
  attribution: z.enum(SUMMARY_ATTRIBUTIONS),
  evidence: z.array(modelEvidenceSchema).max(6),
});
export type SummaryModelItem = z.infer<typeof summaryModelItemSchema>;

const modelSection = z.array(summaryModelItemSchema).max(MAX_SUMMARY_ITEMS_PER_SECTION);

/**
 * The summary model's raw answer (BIB-43). Open questions and conclusions are not here: the server
 * fills them deterministically from the study's own nodes and statuses (section 17: "Existing open
 * questions refer to node IDs and statuses"), so the model can neither invent nor re-status them.
 */
export const summaryModelOutputSchema = z.strictObject({
  focus: z.string().min(1).max(300),
  keyPassages: modelSection,
  textualObservations: modelSection,
  establishedFindings: modelSection,
  tentativeFindings: modelSection,
  tensions: modelSection,
  abandonedHypotheses: modelSection,
  nextDirections: modelSection,
  proposedQuestions: modelSection,
});
export type SummaryModelOutput = z.infer<typeof summaryModelOutputSchema>;

/* ------------------------------------------------------------------------------------------ */
/* BIB-43: StudySummary v1                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * A typed evidence reference (section 17). `node_version`: a study node at the revision the
 * summary read; `scripture`: a Scripture node with its edition and normalized range; `source`: a
 * Source node; `note_version`: a note at its revision; `event`: a Study Thread event.
 */
export const summaryEvidenceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('node_version'),
    nodeId: z.uuid(),
    revision: z.number().int().positive(),
    quote: z.string().nullable(),
  }),
  z.object({
    type: z.literal('scripture'),
    nodeId: z.uuid(),
    referenceId: z.uuid().nullable(),
    editionId: z.uuid().nullable(),
    label: z.string(),
    quote: z.string().nullable(),
  }),
  z.object({
    type: z.literal('source'),
    nodeId: z.uuid(),
    revision: z.number().int().positive(),
    quote: z.string().nullable(),
  }),
  z.object({
    type: z.literal('note_version'),
    noteId: z.uuid(),
    revision: z.number().int().positive(),
    quote: z.string().nullable(),
  }),
  z.object({ type: z.literal('event'), eventId: z.uuid(), sequence: eventSequenceSchema }),
]);
export type SummaryEvidenceRef = z.infer<typeof summaryEvidenceRefSchema>;

/** One generated item, server-validated (section 17). */
export const summaryItemSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  attribution: z.enum(SUMMARY_ATTRIBUTIONS),
  evidenceRefs: z.array(summaryEvidenceRefSchema),
  /** The study nodes, at the revisions read, this item rests on. */
  supportingNodeVersions: z.array(
    z.object({ nodeId: z.uuid(), revision: z.number().int().positive() }),
  ),
});
export type SummaryItem = z.infer<typeof summaryItemSchema>;

/** StudySummary contract version 1 (section 17). Immutable once stored. */
export const studySummarySchema = z.object({
  contractVersion: z.literal(1),
  id: z.uuid(),
  studyId: z.uuid(),
  basisContentRevision: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  promptVersion: z.string(),
  modelId: z.string(),
  contextManifestId: z.uuid(),
  focus: z.string(),
  originalQuestionId: z.uuid().nullable(),
  currentQuestionId: z.uuid().nullable(),
  keyPassages: z.array(summaryItemSchema),
  textualObservations: z.array(summaryItemSchema),
  /** Only items resting on a live user-established observation or supported conclusion. */
  establishedFindings: z.array(summaryItemSchema),
  tentativeFindings: z.array(summaryItemSchema),
  tensions: z.array(summaryItemSchema),
  /** Deterministic: the study's open questions, by node id and status (never AI-decided). */
  openQuestions: z.array(
    z.object({ nodeId: z.uuid(), text: z.string(), status: z.enum(QUESTION_STATUSES) }),
  ),
  /** Deterministic: the study's conclusions with their user-set status and marker. */
  conclusions: z.array(
    z.object({
      nodeId: z.uuid(),
      text: z.string(),
      status: z.enum(CONCLUSION_STATUSES),
      established: z.boolean(),
    }),
  ),
  abandonedHypotheses: z.array(summaryItemSchema),
  /** Suggestions only. */
  nextDirections: z.array(summaryItemSchema),
  /** Suggestions only: never Question nodes until the user adds one. */
  proposedQuestions: z.array(summaryItemSchema),
  coverageWarnings: z.array(z.string()),
});
export type StudySummary = z.infer<typeof studySummarySchema>;

/**
 * `GET /v1/studies/:studyId/summary` (BIB-43). `summary` is the current summary, or the latest
 * valid one when none is current yet; `stale` is true whenever the study changed after its basis
 * ("Based on an earlier version of this study"). A failed or running generation never removes
 * the last valid summary.
 */
export const studySummaryResponseSchema = z.object({
  summary: studySummarySchema.nullable(),
  stale: z.boolean(),
  currentContentRevision: z.number().int().positive(),
  /** A summary job is waiting or running for this study. */
  generating: z.boolean(),
  /** The latest summary job failed after the summary shown was stored. */
  lastFailure: z
    .object({ errorCode: z.enum(AI_JOB_ERROR_CODES), retryable: z.boolean() })
    .nullable(),
});
export type StudySummaryResponse = z.infer<typeof studySummaryResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* BIB-44: tensions and open questions                                                         */
/* ------------------------------------------------------------------------------------------ */

export const TENSION_EDGE_TYPES = ['contradicts', 'qualifies'] as const;
export const MAX_TENSION_PROPOSALS = 3;

/** One proposed tension between two claims (both ids), with a qualified explanation. */
export const tensionModelProposalSchema = z.strictObject({
  firstNodeId: z.uuid(),
  secondNodeId: z.uuid(),
  type: z.enum(TENSION_EDGE_TYPES),
  explanation: z.string().min(1).max(600),
  caveat: z.string().min(1).max(300),
  evidence: z.array(modelEvidenceSchema).min(1).max(4),
});
export const tensionsModelOutputSchema = z.strictObject({
  tensions: z.array(tensionModelProposalSchema).max(MAX_TENSION_PROPOSALS),
});
export type TensionsModelOutput = z.infer<typeof tensionsModelOutputSchema>;

export const MAX_QUESTION_PROPOSALS = 5;

/** Existing open questions (ids) plus proposed new questions, kept separate (section 16). */
export const questionsModelOutputSchema = z.strictObject({
  existingOpenQuestionIds: z.array(z.uuid()).max(20),
  proposedQuestions: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(500),
        rationale: z.string().min(1).max(600),
        evidence: z.array(modelEvidenceSchema).max(4),
      }),
    )
    .max(MAX_QUESTION_PROPOSALS),
});
export type QuestionsModelOutput = z.infer<typeof questionsModelOutputSchema>;

/* ------------------------------------------------------------------------------------------ */
/* BIB-45: next passages                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Section 16: at most five verified passages are shown. */
export const MAX_PASSAGE_PROPOSALS = 5;

export const passagesModelOutputSchema = z.strictObject({
  passages: z
    .array(
      z.strictObject({
        /** A reference as text, e.g. "Romans 8:16". Resolved against the local corpus. */
        reference: z.string().min(1).max(100),
        reason: z.string().min(1).max(400),
      }),
    )
    .max(8),
});
export type PassagesModelOutput = z.infer<typeof passagesModelOutputSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Proposals (questions and passages) as the client reads and decides them                    */
/* ------------------------------------------------------------------------------------------ */

const proposalCommon = {
  id: z.uuid(),
  studyId: z.uuid(),
  /** `expired`: an item it rests on changed or was removed since it was proposed. */
  status: z.enum(AI_SUGGESTION_STATUSES),
  revision: z.number().int().positive(),
  basisRevision: z.number().int().positive(),
  modelId: z.string(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  /** The node the accept created or focused. */
  acceptedNodeId: z.uuid().nullable(),
};

export const aiProposalSchema = z.discriminatedUnion('capability', [
  z.object({
    ...proposalCommon,
    capability: z.literal('questions'),
    text: z.string(),
    rationale: z.string(),
    evidence: z.array(z.object({ id: z.uuid(), quote: z.string().nullable() })),
  }),
  z.object({
    ...proposalCommon,
    capability: z.literal('passages'),
    /** The corpus-verified reference (never a model's unverified text). */
    reference: z.object({
      referenceId: z.uuid(),
      editionId: z.uuid(),
      label: z.string(),
    }),
    reason: z.string(),
  }),
]);
export type AiProposal = z.infer<typeof aiProposalSchema>;

export const AI_PROPOSAL_CAPABILITIES = ['questions', 'passages'] as const;
export type AiProposalCapability = (typeof AI_PROPOSAL_CAPABILITIES)[number];

/** `GET /v1/studies/:studyId/ai/proposals?capability=`: the open proposals of that kind. */
export const listAiProposalsQuerySchema = z.strictObject({
  capability: z.enum(AI_PROPOSAL_CAPABILITIES),
});
export const aiProposalListResponseSchema = z.object({ items: z.array(aiProposalSchema) });
export type AiProposalListResponse = z.infer<typeof aiProposalListResponseSchema>;

/**
 * `POST /v1/studies/:studyId/ai/proposals/:id/accept`. `expectedRevision` is the proposal's. A
 * question proposal may be edited (`text`) before it becomes a Question node; a passage becomes
 * (or focuses) the study's Scripture node for that reference.
 */
export const acceptAiProposalRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  text: userTextSchema({ max: MAX_QUESTION_LENGTH }).optional(),
});
export type AcceptAiProposalRequest = z.input<typeof acceptAiProposalRequestSchema>;

export const acceptAiProposalResponseSchema = z.object({
  proposalId: z.uuid(),
  status: z.literal('accepted'),
  revision: z.number().int().positive(),
  /** `created`: a new node; `existing`: the study already had it (or a replayed accept). */
  outcome: z.enum(['created', 'existing']),
  node: z.object({ id: z.uuid(), type: z.enum(['question', 'scripture']) }),
  lastEventSequence: eventSequenceSchema.nullable(),
});
export type AcceptAiProposalResponse = z.infer<typeof acceptAiProposalResponseSchema>;

export const rejectAiProposalRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
});
export type RejectAiProposalRequest = z.input<typeof rejectAiProposalRequestSchema>;

export const rejectAiProposalResponseSchema = z.object({
  proposalId: z.uuid(),
  status: z.literal('rejected'),
  revision: z.number().int().positive(),
  lastEventSequence: eventSequenceSchema,
});
export type RejectAiProposalResponse = z.infer<typeof rejectAiProposalResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* BIB-45: deterministic reasoning path                                                        */
/* ------------------------------------------------------------------------------------------ */

export const REASONING_GAP_CODES = [
  /** A conclusion version was recorded without any supporting evidence. */
  'no_evidence_recorded',
  /** A relationship this version relied on was removed or retyped later. */
  'evidence_removed',
  /** An item this version relied on was edited or deleted later. */
  'evidence_changed',
  /** No Study Thread event records this version (e.g. it predates the thread). */
  'no_event_recorded',
  /** Nothing about this node was recorded beyond its creation. */
  'no_history',
] as const;
export type ReasoningGapCode = (typeof REASONING_GAP_CODES)[number];

/** Fixed, human-readable copy per gap: the path states what is missing, never guesses it. */
export const REASONING_GAP_MESSAGES: Record<ReasoningGapCode, string> = {
  no_evidence_recorded: 'No supporting evidence was recorded with this version.',
  evidence_removed: 'A relationship this version relied on was removed or changed later.',
  evidence_changed: 'An item this version relied on was edited or deleted later.',
  no_event_recorded: 'The study history has no entry for this version.',
  no_history: 'Nothing else was recorded about how this item developed.',
};

export const reasoningStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('version'),
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    action: z.string(),
    statement: z.string(),
    status: z.string(),
    established: z.boolean(),
    createdAt: z.iso.datetime(),
    eventId: z.uuid().nullable(),
    eventSequence: eventSequenceSchema.nullable(),
    evidence: z.array(
      z.object({
        edgeId: z.uuid(),
        edgeType: z.string(),
        nodeId: z.uuid(),
        label: z.string(),
        edgeLive: z.boolean(),
        nodeLive: z.boolean(),
        nodeChangedSince: z.boolean(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('event'),
    eventId: z.uuid(),
    sequence: eventSequenceSchema,
    eventType: z.string(),
    occurredAt: z.iso.datetime(),
  }),
]);
export type ReasoningStep = z.infer<typeof reasoningStepSchema>;

/**
 * `GET /v1/studies/:studyId/nodes/:nodeId/reasoning` (BIB-45; PRD section 16 "Reasoning
 * reconstruction", deterministic path retrieval without AI): the recorded steps oldest first, and
 * the gaps stated explicitly rather than inferred.
 */
export const reasoningPathResponseSchema = z.object({
  nodeId: z.uuid(),
  steps: z.array(reasoningStepSchema),
  gaps: z.array(
    z.object({
      code: z.enum(REASONING_GAP_CODES),
      message: z.string(),
      versionId: z.uuid().nullable(),
      edgeId: z.uuid().nullable(),
    }),
  ),
});
export type ReasoningPathResponse = z.infer<typeof reasoningPathResponseSchema>;

/**
 * `POST /v1/studies/:studyId/ai/tensions | questions | passages` → 202 with an AI job (BIB-44,
 * BIB-45). `regenerate: true` asks again including proposals dismissed before (FR-AI-004).
 */
export const requestAiInsightSchema = z.strictObject({ regenerate: z.boolean().optional() });
export type RequestAiInsight = z.input<typeof requestAiInsightSchema>;
