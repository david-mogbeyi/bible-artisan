import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { hasForbiddenUserTextCharacter, USER_TEXT_INVALID_CHARACTERS } from './user-text';

/**
 * Typed, directional relationships between two live nodes of one study (BIB-27; PRD sections 12,
 * 23, 24; FR-GRAPH-004/005/006). Edges join nodes only. Wire values are snake_case like every
 * other enum; the PRD's hyphenated names are display wording (`EDGE_TYPE_NAMES`).
 */

/** Directed types read source → target. */
export const DIRECTED_EDGE_TYPES = [
  'supports',
  'contradicts',
  'qualifies',
  'explains',
  'references',
  'answers',
  'raises_question',
  'historical_background',
  'linguistic_background',
  'fulfillment',
  'quotation',
  'inference_from',
  'derived_from',
] as const;

/** Two-way types: stored once with `sourceNodeId < targetNodeId`, read the same from either side. */
export const SYMMETRIC_EDGE_TYPES = ['parallels', 'related_to'] as const;

export const EDGE_TYPES = [...DIRECTED_EDGE_TYPES, ...SYMMETRIC_EDGE_TYPES] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** The default picker (PRD section 12); the rest are under "More relationships". */
export const DEFAULT_EDGE_TYPES = [
  'references',
  'related_to',
  'supports',
  'qualifies',
  'parallels',
  'answers',
] as const satisfies readonly EdgeType[];

/** `ai` is reserved for accepted AI proposals (BIB-42); every edge made here is `user`. */
export const EDGE_ORIGINS = ['user', 'ai'] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

/** NFR-SCALE-002. */
export const MAX_EDGES_PER_STUDY = 6000;
/** PRD section 12: an edge note is plain text of at most 2,000 characters. */
export const MAX_EDGE_NOTE_LENGTH = 2000;

const SYMMETRIC: ReadonlySet<string> = new Set(SYMMETRIC_EDGE_TYPES);

export function isSymmetricEdgeType(type: EdgeType): boolean {
  return SYMMETRIC.has(type);
}

/** Types whose target must be a Question node. */
export const QUESTION_TARGET_EDGE_TYPES = [
  'answers',
  'raises_question',
] as const satisfies readonly EdgeType[];

export function requiresQuestionTarget(type: EdgeType): boolean {
  return (QUESTION_TARGET_EDGE_TYPES as readonly EdgeType[]).includes(type);
}

/** The types an edge of `type` may change to: the same direction class (directed or two-way). */
export function sameDirectionClassTypes(type: EdgeType): readonly EdgeType[] {
  return isSymmetricEdgeType(type) ? SYMMETRIC_EDGE_TYPES : DIRECTED_EDGE_TYPES;
}

export const EDGE_TYPE_NAMES: Record<EdgeType, string> = {
  supports: 'Supports',
  contradicts: 'Contradicts',
  qualifies: 'Qualifies',
  explains: 'Explains',
  references: 'References',
  answers: 'Answers',
  raises_question: 'Raises question',
  historical_background: 'Historical background',
  linguistic_background: 'Linguistic background',
  fulfillment: 'Fulfillment',
  quotation: 'Quotation',
  inference_from: 'Inference from',
  derived_from: 'Derived from',
  parallels: 'Parallels',
  related_to: 'Related to',
};

/**
 * How an edge reads, the only place its direction is explained (PRD section 12: "Relationship
 * editing always presents the direction in words"). `outgoing`: "<source> … <target>";
 * `incoming`: "<target> … <source>". Two-way types read the same both ways.
 */
export const EDGE_PHRASES: Record<EdgeType, { outgoing: string; incoming: string }> = {
  supports: { outgoing: 'supports', incoming: 'is supported by' },
  contradicts: { outgoing: 'contradicts', incoming: 'is contradicted by' },
  qualifies: { outgoing: 'qualifies', incoming: 'is qualified by' },
  explains: { outgoing: 'explains', incoming: 'is explained by' },
  references: { outgoing: 'references', incoming: 'is referenced by' },
  answers: { outgoing: 'answers', incoming: 'is answered by' },
  raises_question: { outgoing: 'raises the question', incoming: 'is raised by' },
  historical_background: {
    outgoing: 'gives historical background for',
    incoming: 'has historical background in',
  },
  linguistic_background: {
    outgoing: 'gives language background for',
    incoming: 'has language background in',
  },
  fulfillment: {
    outgoing: 'is proposed as a fulfillment of',
    incoming: 'is proposed as fulfilled by',
  },
  quotation: { outgoing: 'quotes', incoming: 'is quoted by' },
  inference_from: { outgoing: 'is inferred from', incoming: 'is the basis for inferring' },
  derived_from: { outgoing: 'is derived from', incoming: 'is the origin of' },
  parallels: { outgoing: 'parallels', incoming: 'parallels' },
  related_to: { outgoing: 'is related to', incoming: 'is related to' },
};

/** Helper copy shown under the type picker (PRD sections 12, 24). */
export const EDGE_TYPE_HELP: Partial<Record<EdgeType, string>> = {
  inference_from: 'The first item is a conclusion drawn from the second.',
  fulfillment: 'An interpretive label, not textual proof.',
  quotation: 'An interpretive label, not textual proof.',
  related_to: 'No claim that one supports the other.',
};

export const EDGE_TARGET_NOT_QUESTION = 'EDGE_TARGET_NOT_QUESTION';
export const EDGE_LIMIT_EXCEEDED = 'EDGE_LIMIT_EXCEEDED';
export const EDGE_TYPE_CHANGE_NOT_ALLOWED = 'EDGE_TYPE_CHANGE_NOT_ALLOWED';
export const EDGE_EXISTS = 'EDGE_EXISTS';
export const EDGE_UNCHANGED = 'EDGE_UNCHANGED';

export const EDGE_ERROR_CODES = [
  EDGE_TARGET_NOT_QUESTION,
  EDGE_LIMIT_EXCEEDED,
  EDGE_TYPE_CHANGE_NOT_ALLOWED,
  EDGE_EXISTS,
  EDGE_UNCHANGED,
] as const;
export type EdgeErrorCode = (typeof EDGE_ERROR_CODES)[number];

/** Fixed messages: never a node's text, a label or a note. */
export const EDGE_ERROR_MESSAGES: Record<EdgeErrorCode, string> = {
  [EDGE_TARGET_NOT_QUESTION]: 'This relationship must point to a question',
  [EDGE_LIMIT_EXCEEDED]: `A study can hold at most ${MAX_EDGES_PER_STUDY.toLocaleString('en-US')} relationships`,
  [EDGE_TYPE_CHANGE_NOT_ALLOWED]:
    'A relationship can only change to a type with the same direction. Remove it and connect again',
  [EDGE_EXISTS]: 'These nodes already have this relationship',
  [EDGE_UNCHANGED]: 'The relationship already has these values',
};

/** Field-error copy (400). */
export const EDGE_SELF_CONNECTION = 'Choose two different nodes';
export const EDGE_EDIT_EMPTY = 'Send a type or a note to change';

/**
 * An edge note: plain text, trimmed, at most 2,000 characters. Empty or only whitespace means no
 * note (null), and `null` clears one. Never rich text.
 */
export const edgeNoteSchema = z
  .string()
  .trim()
  .max(MAX_EDGE_NOTE_LENGTH)
  .refine((text) => !hasForbiddenUserTextCharacter(text), {
    message: USER_TEXT_INVALID_CHARACTERS,
  })
  .transform((text) => (text === '' ? null : text))
  .nullable();

/**
 * A node id, lower-cased so comparisons and the two-way sort match PostgreSQL's uuid order. Not
 * checked as a uuid here: like an id in a path, a malformed endpoint is the same 404 as an absent
 * or another user's node (the server checks the shape before any query).
 */
const nodeIdSchema = z
  .string()
  .max(64)
  .transform((id) => id.toLowerCase());

/**
 * `POST /v1/studies/:studyId/edges`. Connecting is a study change, so `expectedRevision` is the
 * study's. The client never sends an origin, owner, study, revision or deletion (unknown key,
 * 400). A self-edge is a 400 on `targetNodeId`.
 */
export const createEdgeRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    sourceNodeId: nodeIdSchema,
    targetNodeId: nodeIdSchema,
    type: z.enum(EDGE_TYPES),
    note: edgeNoteSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.sourceNodeId === body.targetNodeId) {
      ctx.addIssue({ code: 'custom', path: ['targetNodeId'], message: EDGE_SELF_CONNECTION });
    }
  });

export type CreateEdgeRequest = z.input<typeof createEdgeRequestSchema>;

/**
 * `PATCH /v1/studies/:studyId/edges/:edgeId`: the edge's revision and a new `type` (same direction
 * class) and/or `note` (`null` clears it). Endpoints and direction never change.
 */
export const updateEdgeRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    type: z.enum(EDGE_TYPES).optional(),
    note: edgeNoteSchema.optional(),
  })
  .refine((body) => body.type !== undefined || body.note !== undefined, {
    message: EDGE_EDIT_EMPTY,
  });

export type UpdateEdgeRequest = z.input<typeof updateEdgeRequestSchema>;

/** `DELETE /v1/studies/:studyId/edges/:edgeId`: the edge's revision. */
export const edgeStateRequestSchema = z.strictObject({ expectedRevision: expectedRevisionSchema });

export type EdgeStateRequest = z.input<typeof edgeStateRequestSchema>;

/**
 * `GET /v1/studies/:studyId/edges?nodeId=`: the live edges touching one live node. Only an opaque
 * id travels in the URL. A malformed id is the same 404 as an absent node.
 */
export const listEdgesQuerySchema = z.strictObject({ nodeId: z.string().max(64) });

/**
 * 200 from `PATCH` and `DELETE`: the edge's new state without its note. Mutation responses are
 * stored on their Idempotency-Key receipt, so the note never reaches `mutation_receipt`.
 */
const edgeMutationBase = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.enum(EDGE_TYPES),
  origin: z.enum(EDGE_ORIGINS),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastEventSequence: eventSequenceSchema,
});

/**
 * `establishmentClearedNodeIds` (BIB-30): the conclusions whose "Established by me" this change
 * cleared because it removed or retyped their last supporting evidence; usually empty.
 */
export const edgeMutationResponseSchema = edgeMutationBase.extend({
  establishmentClearedNodeIds: z.array(z.uuid()),
});

export type EdgeMutationResponse = z.infer<typeof edgeMutationResponseSchema>;

export const EDGE_CREATE_OUTCOMES = ['created', 'existing'] as const;
export type EdgeCreateOutcome = (typeof EDGE_CREATE_OUTCOMES)[number];

/**
 * From `POST`: 201 `created` (the new edge; `studyRevision` the revision it moved the study to) or
 * 200 `existing` (the live edge that already joins these nodes with this type, in its stored
 * order; nothing was written, so `studyRevision` is the study's current one and
 * `lastEventSequence` is null).
 */
export const createEdgeResponseSchema = edgeMutationBase.extend({
  outcome: z.enum(EDGE_CREATE_OUTCOMES),
  studyRevision: z.number().int().positive(),
  lastEventSequence: eventSequenceSchema.nullable(),
});

export type CreateEdgeResponse = z.infer<typeof createEdgeResponseSchema>;

/** One live edge as read, with its note. */
export const edgeSchema = z.object({
  id: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.enum(EDGE_TYPES),
  origin: z.enum(EDGE_ORIGINS),
  note: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Edge = z.infer<typeof edgeSchema>;

/** Oldest first (ties by id); bounded by the per-study cap. */
export const edgeListResponseSchema = z.object({ items: z.array(edgeSchema) });

export type EdgeListResponse = z.infer<typeof edgeListResponseSchema>;
