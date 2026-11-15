import { z } from 'zod';
import { eventSequenceSchema } from './mutation';

/**
 * Study Thread (BIB-55, BIB-32; PRD sections 13, 21 FR-THREAD-001…006, 23, 24).
 *
 * Domain mutations write their events in their own transaction. Reading and navigation commit
 * through `POST /studies/:id/activity`, idempotent by `clientMutationId`. The thread is read
 * newest first (or oldest first) through a 50-record sequence cursor; new events never repeat or
 * skip an earlier page.
 */

export const STUDY_EVENT_VISIBILITIES = ['visible', 'internal'] as const;
export type StudyEventVisibility = (typeof STUDY_EVENT_VISIBILITIES)[number];

export const STUDY_EVENT_ACTOR_KINDS = ['user', 'ai', 'system'] as const;
export type StudyEventActorKind = (typeof STUDY_EVENT_ACTOR_KINDS)[number];

/** Activity event types (written only through `POST /studies/:id/activity`). */
export const SCRIPTURE_OPENED = 'scripture_opened';
export const PHRASE_SELECTED = 'phrase_selected';
export const SEARCH_PERFORMED = 'search_performed';

/**
 * PRD section 13's internal-only families, plus the lifecycle events BIB-22 marked internal.
 * Hidden from the default thread; shown only with `includeInternal=true`.
 */
export const INTERNAL_EVENT_TYPES: readonly string[] = [
  PHRASE_SELECTED,
  SEARCH_PERFORMED,
  'note_autosaved',
  'node_position_saved',
  'view_state_saved',
  'summary_queued',
  'summary_failed',
  'session_started',
  'session_ended',
  'study_trashed',
  'study_restored',
];

export function studyEventVisibility(eventType: string): StudyEventVisibility {
  return INTERNAL_EVENT_TYPES.includes(eventType) ? 'internal' : 'visible';
}

/**
 * Where a deliberate visit came from. Only what was recorded: the thread never invents a motive.
 * - `search`: the reader's reference search;
 * - `reader`: a link inside the reader (next/previous chapter, a chapter list);
 * - `study`: a link on the study page;
 * - `node`: a graph node (send `origin.nodeId`);
 * - `event`: an earlier thread event (send `origin.eventId`); the old event is never changed;
 * - `direct`: a typed URL or bookmark.
 */
export const VISIT_ORIGIN_KINDS = ['search', 'reader', 'study', 'node', 'event', 'direct'] as const;
export type VisitOriginKind = (typeof VISIT_ORIGIN_KINDS)[number];

const id = z.uuid().transform((value) => value.toLowerCase());

/** PRD section 23: a delayed client event may be at most this old (the offline queue lifetime). */
export const ACTIVITY_MAX_DELAY_DAYS = 7;
export const SEARCH_QUERY_MAX = 200;

const activityBase = {
  /** The client's operation id: a retry resends it with the identical body (FR-THREAD-004). */
  clientMutationId: id,
  /** The browser tab's session id, when the client has one. */
  sessionId: id.nullable().optional(),
  /** When it happened on the client; the server records its own time too. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  branchId: id.nullable().optional(),
  parentVisitEventId: id.nullable().optional(),
};

export const visitOriginSchema = z
  .object({
    kind: z.enum(VISIT_ORIGIN_KINDS),
    nodeId: id.optional(),
    eventId: id.optional(),
    /** The passage the user came from (e.g. the chapter they were reading). */
    referenceId: id.optional(),
  })
  .strict()
  .superRefine((origin, ctx) => {
    if (origin.kind === 'node' && !origin.nodeId) {
      ctx.addIssue({ code: 'custom', path: ['nodeId'], message: 'Required for a node origin' });
    }
    if (origin.kind === 'event' && !origin.eventId) {
      ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'Required for an event origin' });
    }
  });
export type VisitOrigin = z.output<typeof visitOriginSchema>;

export const recordActivityRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('visit'),
      ...activityBase,
      /** The passage opened, after its text loaded. */
      referenceId: id,
      /** The Scripture node opened, when the visit is of a node. */
      nodeId: id.nullable().optional(),
      origin: visitOriginSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('selection'),
      ...activityBase,
      referenceId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal('search'),
      ...activityBase,
      /** Stored only in the private study event, never logs or analytics. */
      query: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
    })
    .strict(),
]);
export type RecordActivityRequest = z.input<typeof recordActivityRequestSchema>;

export const recordActivityResponseSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  sequence: eventSequenceSchema,
  lastEventSequence: eventSequenceSchema,
});
export type RecordActivityResponse = z.infer<typeof recordActivityResponseSchema>;

/** Thread filters (PRD section 11: question / conclusions / navigation). */
export const THREAD_FILTERS = ['all', 'questions', 'conclusions', 'navigation'] as const;
export type ThreadFilter = (typeof THREAD_FILTERS)[number];
export const THREAD_ORDERS = ['desc', 'asc'] as const;
export type ThreadOrder = (typeof THREAD_ORDERS)[number];
export const THREAD_PAGE_MAX = 50;

export const threadEventsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(THREAD_PAGE_MAX).default(THREAD_PAGE_MAX),
    filter: z.enum(THREAD_FILTERS).default('all'),
    order: z.enum(THREAD_ORDERS).default('desc'),
    branchId: id.optional(),
    includeInternal: z.enum(['true', 'false']).default('false'),
  })
  .strict();
export type ThreadEventsQuery = z.input<typeof threadEventsQuerySchema>;

export const THREAD_REF_KINDS = ['node', 'reference', 'edge', 'event'] as const;

/** What an event is about, with a readable label when one exists. */
export const threadRefSchema = z.object({
  kind: z.enum(THREAD_REF_KINDS),
  id: z.uuid(),
  label: z.string().nullable(),
  /** True when the node no longer exists in the graph (tombstone). */
  deleted: z.boolean(),
});
export type ThreadRef = z.infer<typeof threadRefSchema>;

export const threadOriginSchema = z.object({
  kind: z.string(),
  ref: threadRefSchema.nullable(),
});
export type ThreadOrigin = z.infer<typeof threadOriginSchema>;

export const studyEventItemSchema = z.object({
  id: z.uuid(),
  sequence: eventSequenceSchema,
  type: z.string(),
  visibility: z.enum(STUDY_EVENT_VISIBILITIES),
  actorKind: z.enum(STUDY_EVENT_ACTOR_KINDS),
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  sessionId: z.uuid().nullable(),
  /** Deterministic copy built from what was recorded; never a guessed motive. */
  displayText: z.string(),
  targetRef: threadRefSchema.nullable(),
  originRef: threadOriginSchema.nullable(),
  branchId: z.uuid().nullable(),
  parentVisitEventId: z.uuid().nullable(),
  correlationId: z.uuid().nullable(),
  /** Recorded well after it happened (an offline client syncing later). */
  delayedSync: z.boolean(),
});
export type StudyEventItem = z.infer<typeof studyEventItemSchema>;

export const threadEventsResponseSchema = z.object({
  items: z.array(studyEventItemSchema),
  nextCursor: z.string().nullable(),
});
export type ThreadEventsResponse = z.infer<typeof threadEventsResponseSchema>;

export const studyEventDetailSchema = z.object({
  event: studyEventItemSchema,
  schemaVersion: z.number().int(),
  /** The raw recorded payload: ids, bounded labels and flags only. */
  details: z.record(z.string(), z.unknown()),
  /** Every event of the same action (same correlation id), oldest first, this one included. */
  correlated: z.array(studyEventItemSchema),
});
export type StudyEventDetail = z.infer<typeof studyEventDetailSchema>;

/** Recorded more than this long after it happened → `delayedSync`. */
export const DELAYED_SYNC_MS = 2 * 60 * 1000;
