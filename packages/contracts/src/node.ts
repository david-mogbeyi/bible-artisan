import { z } from 'zod';
import { scriptureReferenceSchema } from './bible';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { MAX_QUESTION_LENGTH, QUESTION_STATUSES, STUDY_NODE_TYPES } from './study';
import { httpUrlSchema } from './url';
import { userTextSchema } from './user-text';

/**
 * Typed graph nodes (BIB-25; PRD sections 8, 12, 15, 16, 23, 24; FR-GRAPH-001). Six types, each
 * with its own strict shape. A node's `type` never changes, and its `origin` (who or what the
 * content comes from) is set by the server from how the node was made, never by the client, and
 * is shown separately from its status. Graph DTOs stay independent of any canvas library.
 */

export type StudyNodeType = (typeof STUDY_NODE_TYPES)[number];

/** PRD section 23 `origin`. `ai` is reserved for Epic 7's accept flow; nothing writes it yet. */
export const NODE_ORIGINS = ['user', 'ai', 'external', 'scripture'] as const;
export type NodeOrigin = (typeof NODE_ORIGINS)[number];

export const OBSERVATION_KINDS = ['textual_observation', 'interpretation'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** PRD section 12. Conclusions start `tentative`; the transitions are BIB-30's. */
export const CONCLUSION_STATUSES = [
  'tentative',
  'supported',
  'challenged',
  'revised',
  'abandoned',
] as const;
export type ConclusionStatus = (typeof CONCLUSION_STATUSES)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** PRD section 23 `Source.kind`. */
export const SOURCE_KINDS = [
  'lexicon',
  'commentary',
  'church_father',
  'article',
  'book',
  'web',
  'manual',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** A source excerpt is either quoted exactly or paraphrased (PRD section 16). */
export const EXCERPT_KINDS = ['quotation', 'paraphrase'] as const;
export type ExcerptKind = (typeof EXCERPT_KINDS)[number];

/** Observation and Thought text (PRD section 15). Statements use `MAX_QUESTION_LENGTH`. */
export const MAX_NODE_TEXT_LENGTH = 10_000;
export const MAX_SOURCE_TITLE_LENGTH = 200;
export const MAX_SOURCE_AUTHOR_LENGTH = 200;
export const MAX_SOURCE_WORK_TITLE_LENGTH = 200;
export const MAX_SOURCE_PUBLICATION_LENGTH = 500;
export const MAX_SOURCE_LOCATOR_LENGTH = 200;
export const MAX_SOURCE_EXCERPT_LENGTH = 10_000;
/** NFR-SCALE-002: live nodes one study may hold. */
export const MAX_NODES_PER_STUDY = 2000;
/** PRD section 11: "previews show at most 160 characters". */
export const NODE_PREVIEW_LENGTH = 160;

/** 422: the study already holds `MAX_NODES_PER_STUDY` live nodes. */
export const NODE_LIMIT_EXCEEDED = 'NODE_LIMIT_EXCEEDED';
/** 422: this node type, or this field on it, cannot be edited here. */
export const NODE_NOT_EDITABLE = 'NODE_NOT_EDITABLE';
/** 422: the edit changes nothing. */
export const NODE_UNCHANGED = 'NODE_UNCHANGED';

export const NODE_ERROR_CODES = [NODE_LIMIT_EXCEEDED, NODE_NOT_EDITABLE, NODE_UNCHANGED] as const;
export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number];

/** Fixed messages: never a node's text, a label or a reference. */
export const NODE_ERROR_MESSAGES: Record<NodeErrorCode, string> = {
  [NODE_LIMIT_EXCEEDED]: `A study can hold at most ${MAX_NODES_PER_STUDY.toLocaleString('en-US')} nodes`,
  [NODE_NOT_EDITABLE]: 'This node cannot be edited this way',
  [NODE_UNCHANGED]: 'The node already has these values',
};

/**
 * Adding a Scripture reference the study already holds as a live canonical node (BIB-26; PRD
 * sections 12, 24; FR-GRAPH-002/003). `focus_existing`, the default, records the deliberate
 * return as a visit and creates nothing; `explicit_duplicate` creates a labeled noncanonical copy
 * linked to the canonical node. With no canonical node, both simply create it.
 */
export const DUPLICATE_POLICIES = ['focus_existing', 'explicit_duplicate'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

/**
 * What `POST /nodes` did: `created` (201, a new canonical node, and every non-Scripture create),
 * `focused_existing` (200, the existing canonical node; no node written, contentRevision
 * unchanged) or `explicit_duplicate` (201, a new copy whose `canonicalNodeId` names the original).
 */
export const NODE_CREATE_OUTCOMES = ['created', 'focused_existing', 'explicit_duplicate'] as const;
export type NodeCreateOutcome = (typeof NODE_CREATE_OUTCOMES)[number];

/** What the UI calls each type, origin, status and kind: text, never color alone (WCAG). */
export const NODE_TYPE_NAMES: Record<StudyNodeType, string> = {
  scripture: 'Scripture',
  question: 'Question',
  observation: 'Observation',
  thought: 'Thought',
  conclusion: 'Conclusion',
  source: 'Source',
};

/** PRD section 16's source badges. */
export const NODE_ORIGIN_NAMES: Record<NodeOrigin, string> = {
  user: 'You',
  ai: 'AI Suggested',
  external: 'External Source',
  scripture: 'Scripture Text',
};

export const NODE_STATUS_NAMES: Record<QuestionStatus | ConclusionStatus, string> = {
  open: 'Open',
  partially_answered: 'Partially answered',
  answered: 'Answered',
  deferred: 'Deferred',
  tentative: 'Tentative',
  supported: 'Supported',
  challenged: 'Challenged',
  revised: 'Revised',
  abandoned: 'Abandoned',
};

export const OBSERVATION_KIND_NAMES: Record<ObservationKind, string> = {
  textual_observation: 'Textual observation',
  interpretation: 'Interpretation',
};

export const SOURCE_KIND_NAMES: Record<SourceKind, string> = {
  lexicon: 'Lexicon',
  commentary: 'Commentary',
  church_father: 'Church father',
  article: 'Article',
  book: 'Book',
  web: 'Web page',
  manual: 'Other',
};

export const EXCERPT_KIND_NAMES: Record<ExcerptKind, string> = {
  quotation: 'Quotation',
  paraphrase: 'Paraphrase',
};

/**
 * A node's label as every list shows it (the node list, a note's target, the Notes "Attach to"
 * select): whitespace runs collapsed, trimmed, the first `NODE_PREVIEW_LENGTH` code points. A
 * Scripture node's label is its reference label instead. Mirrors `notePreview`.
 */
export function nodePreview(text: string): string {
  return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, NODE_PREVIEW_LENGTH).join('');
}

/** A Scripture node's label when its edition is no longer active (no label can be derived). */
export const SCRIPTURE_LABEL_UNAVAILABLE = 'Passage (translation unavailable)';

/** The stored fields a node's label comes from. */
export interface NodeLabelSource {
  title: string | null;
  body: string | null;
  scriptureReferenceId: string | null;
}

/**
 * A node's label, the one rule for every place that names a node (the node list, a note's
 * target): a Scripture node's reference label from `references` (keyed by reference id, holding
 * only references of active editions), or `SCRIPTURE_LABEL_UNAVAILABLE` when its edition is no
 * longer active; otherwise the `nodePreview` of its statement, text or source title.
 */
export function nodeLabel(
  node: NodeLabelSource,
  references: ReadonlyMap<string, { label: string }>,
): string {
  if (node.scriptureReferenceId !== null) {
    return references.get(node.scriptureReferenceId)?.label ?? SCRIPTURE_LABEL_UNAVAILABLE;
  }
  return nodePreview(node.title ?? node.body ?? '');
}

export const SOURCE_LOCATION_REQUIRED = 'Add a URL or a locator';
export const SOURCE_EXCERPT_KIND_REQUIRED =
  'Say whether the excerpt is a quotation or a paraphrase';
export const SOURCE_EXCERPT_REQUIRED = 'Add the excerpt, or leave its kind unset';
export const NODE_EDIT_EMPTY = 'Send a field to change';

/** An optional citation field: trimmed; empty means absent. */
const optionalText = (max: number) =>
  userTextSchema({ min: 0, max })
    .transform((text) => (text === '' ? undefined : text))
    .optional();

/**
 * A manual source citation (PRD section 23 `Source`, BIB-25). Strict: an unknown key is a 400.
 * Optional strings are trimmed and an empty one is absent. `url` passes `httpUrlSchema` (http or
 * https only, no credentials); the server stores it and never fetches it. At least one of `url`
 * and `locator`; `excerpt` and `excerptKind` together or not at all.
 */
export const sourceSchema = z
  .strictObject({
    title: userTextSchema({ max: MAX_SOURCE_TITLE_LENGTH }),
    kind: z.enum(SOURCE_KINDS),
    author: optionalText(MAX_SOURCE_AUTHOR_LENGTH),
    workTitle: optionalText(MAX_SOURCE_WORK_TITLE_LENGTH),
    publicationDetails: optionalText(MAX_SOURCE_PUBLICATION_LENGTH),
    url: z
      .preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
        httpUrlSchema.optional(),
      )
      .optional(),
    locator: optionalText(MAX_SOURCE_LOCATOR_LENGTH),
    excerpt: optionalText(MAX_SOURCE_EXCERPT_LENGTH),
    excerptKind: z.enum(EXCERPT_KINDS).optional(),
  })
  .superRefine((source, ctx) => {
    if (source.url === undefined && source.locator === undefined) {
      ctx.addIssue({ code: 'custom', path: ['locator'], message: SOURCE_LOCATION_REQUIRED });
    }
    if (source.excerpt !== undefined && source.excerptKind === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['excerptKind'],
        message: SOURCE_EXCERPT_KIND_REQUIRED,
      });
    }
    if (source.excerpt === undefined && source.excerptKind !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['excerpt'], message: SOURCE_EXCERPT_REQUIRED });
    }
  })
  // Only the fields present, so the stored citation and an edit's comparison hold no empty keys.
  .transform(
    (source) =>
      Object.fromEntries(
        Object.entries(source).filter(([, value]) => value !== undefined),
      ) as typeof source,
  );

export type SourceInput = z.input<typeof sourceSchema>;
/** A validated citation: only the fields present, as stored in `payload_json`. */
export type SourceCitation = z.output<typeof sourceSchema>;

/** A citation as read back: every field, null when absent. */
export const sourceResponseSchema = z.object({
  title: z.string(),
  kind: z.enum(SOURCE_KINDS),
  author: z.string().nullable(),
  workTitle: z.string().nullable(),
  publicationDetails: z.string().nullable(),
  url: z.string().nullable(),
  locator: z.string().nullable(),
  excerpt: z.string().nullable(),
  excerptKind: z.enum(EXCERPT_KINDS).nullable(),
});

export type Source = z.infer<typeof sourceResponseSchema>;

const statementSchema = userTextSchema({ max: MAX_QUESTION_LENGTH });
const nodeTextSchema = userTextSchema({ max: MAX_NODE_TEXT_LENGTH });

/**
 * `POST /v1/studies/:studyId/nodes`: one strict branch per type. Creating a node is a study
 * change, so `expectedRevision` is the study's. The client never sends an origin, a status, an
 * owner, a study or a revision: each is an unknown key (400).
 */
export const createNodeRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('scripture'),
    expectedRevision: expectedRevisionSchema,
    referenceId: z.uuid(),
    /** Omitted means `focus_existing`. The client never names the canonical node. */
    duplicatePolicy: z.enum(DUPLICATE_POLICIES).optional(),
  }),
  z.strictObject({
    type: z.literal('question'),
    expectedRevision: expectedRevisionSchema,
    text: statementSchema,
  }),
  z.strictObject({
    type: z.literal('observation'),
    expectedRevision: expectedRevisionSchema,
    text: nodeTextSchema,
    observationKind: z.enum(OBSERVATION_KINDS),
  }),
  z.strictObject({
    type: z.literal('thought'),
    expectedRevision: expectedRevisionSchema,
    text: nodeTextSchema,
  }),
  z.strictObject({
    type: z.literal('conclusion'),
    expectedRevision: expectedRevisionSchema,
    text: statementSchema,
  }),
  z.strictObject({
    type: z.literal('source'),
    expectedRevision: expectedRevisionSchema,
    source: sourceSchema,
  }),
]);

export type CreateNodeRequest = z.input<typeof createNodeRequestSchema>;

/**
 * `PATCH /v1/studies/:studyId/nodes/:nodeId`: the node's revision and new content for an
 * Observation (`text`, `observationKind`), a Thought (`text`) or a Source (`source`, replaced
 * whole). No `type`: a node's type never changes. A field that does not belong to the node's
 * type, or any edit of a Question, Conclusion or Scripture node, is 422 `NODE_NOT_EDITABLE`.
 */
export const updateNodeRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    text: nodeTextSchema.optional(),
    observationKind: z.enum(OBSERVATION_KINDS).optional(),
    source: sourceSchema.optional(),
  })
  .refine(
    (body) =>
      body.text !== undefined || body.observationKind !== undefined || body.source !== undefined,
    { message: NODE_EDIT_EMPTY },
  );

export type UpdateNodeRequest = z.input<typeof updateNodeRequestSchema>;

/**
 * 200 from `PATCH`: the node's new state without its text. Every mutation response is stored on
 * its Idempotency-Key receipt, so private text never reaches `mutation_receipt`; the client
 * refetches the node.
 */
export const nodeMutationResponseSchema = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  type: z.enum(STUDY_NODE_TYPES),
  origin: z.enum(NODE_ORIGINS),
  revision: z.number().int().positive(),
  /** A Scripture node's reference, else null. */
  referenceId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastEventSequence: eventSequenceSchema,
});

export type NodeMutationResponse = z.infer<typeof nodeMutationResponseSchema>;

/**
 * From `POST`: as above (the new node's, or for `focused_existing` the existing canonical node's,
 * fields), plus the study revision the request moved to, what it did, and the canonical node a
 * new duplicate copies (else null).
 */
export const createNodeResponseSchema = nodeMutationResponseSchema.extend({
  studyRevision: z.number().int().positive(),
  outcome: z.enum(NODE_CREATE_OUTCOMES),
  canonicalNodeId: z.uuid().nullable(),
});

export type CreateNodeResponse = z.infer<typeof createNodeResponseSchema>;

/** One live node in the study's list: compact, with its label and no full text. */
export const nodeSummarySchema = z.object({
  id: z.uuid(),
  type: z.enum(STUDY_NODE_TYPES),
  origin: z.enum(NODE_ORIGINS),
  label: z.string(),
  status: z.enum([...QUESTION_STATUSES, ...CONCLUSION_STATUSES]).nullable(),
  observationKind: z.enum(OBSERVATION_KINDS).nullable(),
  referenceId: z.uuid().nullable(),
  /** A duplicate Scripture node's canonical node (BIB-26), else null. */
  canonicalNodeId: z.uuid().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type NodeSummary = z.infer<typeof nodeSummarySchema>;

/** `GET /v1/studies/:studyId/nodes`: live nodes, oldest first (ties by id). Bounded by the cap. */
export const nodeListResponseSchema = z.object({ items: z.array(nodeSummarySchema) });

export type NodeListResponse = z.infer<typeof nodeListResponseSchema>;

const nodeCommon = {
  id: z.uuid(),
  studyId: z.uuid(),
  origin: z.enum(NODE_ORIGINS),
  /** A duplicate Scripture node's canonical node (BIB-26), else null. */
  canonicalNodeId: z.uuid().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/**
 * `GET /v1/studies/:studyId/nodes/:nodeId`: one live node with its full typed content. A
 * Scripture node carries its reference (null only if its edition stopped being active), never
 * verse text: the reader shows the text.
 */
export const nodeResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scripture'),
    ...nodeCommon,
    reference: scriptureReferenceSchema.nullable(),
  }),
  z.object({
    type: z.literal('question'),
    ...nodeCommon,
    text: z.string(),
    status: z.enum(QUESTION_STATUSES),
  }),
  z.object({
    type: z.literal('observation'),
    ...nodeCommon,
    text: z.string(),
    observationKind: z.enum(OBSERVATION_KINDS),
  }),
  z.object({ type: z.literal('thought'), ...nodeCommon, text: z.string() }),
  z.object({
    type: z.literal('conclusion'),
    ...nodeCommon,
    text: z.string(),
    status: z.enum(CONCLUSION_STATUSES),
  }),
  z.object({ type: z.literal('source'), ...nodeCommon, source: sourceResponseSchema }),
]);

export type NodeResponse = z.infer<typeof nodeResponseSchema>;
