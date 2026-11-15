import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { CONCLUSION_STATUSES } from './node';
import { QUESTION_STATUSES } from './study';

/**
 * Deterministic resume (BIB-34; PRD sections 11, 18, 21 FR-STUDY-007/008, 23, 24).
 *
 * `PATCH /studies/:id/view-state` saves the workspace's last meaningful context (selected node,
 * active branch, reader passage, viewport, panes), checked against the study's **view revision**
 * (the same `study_view_state.revision` position saves use), never the study revision or content
 * revision, and it never moves `last_activity_at`.
 *
 * `GET /studies/:id/resume` answers from saved state only: no AI, so it works the same with AI
 * disabled or failing (FR-STUDY-008).
 */

const id = z.uuid().transform((value) => value.toLowerCase());

/** Canvas viewport, in canvas units (presentation only). */
export const viewportSchema = z.strictObject({
  x: z.number().min(-1_000_000).max(1_000_000),
  y: z.number().min(-1_000_000).max(1_000_000),
  zoom: z.number().min(0.01).max(100),
});
export type Viewport = z.infer<typeof viewportSchema>;

/** `summary` is the narrow layout's Summary tab (BIB-38); the web saves which tab is open. */
export const PANE_NAMES = ['graph', 'nodes', 'notes', 'thread', 'reader', 'summary'] as const;
export type PaneName = (typeof PANE_NAMES)[number];
/** Which panes are open (true) or collapsed (false). Names only, never content. */
export const paneStateSchema = z.partialRecord(z.enum(PANE_NAMES), z.boolean());
export type PaneState = z.infer<typeof paneStateSchema>;

/**
 * Every field but `expectedRevision` is optional: a field left out keeps its saved value, and
 * `null` clears it. Ids must name this study's live node or its branch (404 otherwise). Selecting
 * a Question node also makes it the active question.
 */
export const saveViewStateRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    selectedNodeId: id.nullable().optional(),
    activeBranchId: id.nullable().optional(),
    readerReferenceId: id.nullable().optional(),
    viewport: viewportSchema.nullable().optional(),
    panes: paneStateSchema.nullable().optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'expectedRevision'),
    'Send at least one view-state field',
  );
export type SaveViewStateRequest = z.input<typeof saveViewStateRequestSchema>;

export const viewStateSchema = z.object({
  viewRevision: z.number().int().positive(),
  selectedNodeId: z.uuid().nullable(),
  activeBranchId: z.uuid().nullable(),
  activeQuestionNodeId: z.uuid().nullable(),
  readerReferenceId: z.uuid().nullable(),
  viewport: viewportSchema.nullable(),
  panes: paneStateSchema.nullable(),
  /**
   * When the context (selection, branch) was last saved; null when never. A reader passage save
   * does not move it: the deliberate visit (a `scripture_opened` event) is what resume compares.
   */
  contextSavedAt: z.iso.datetime().nullable(),
});
export type ViewState = z.infer<typeof viewStateSchema>;

/** 200 from `PATCH /studies/:id/view-state`. */
export const saveViewStateResponseSchema = z.object({
  viewState: viewStateSchema,
  lastEventSequence: eventSequenceSchema,
});
export type SaveViewStateResponse = z.infer<typeof saveViewStateResponseSchema>;

/** How many open questions the resume card lists (PRD section 18: "up to three … View All"). */
export const RESUME_OPEN_QUESTIONS = 3;

/**
 * Where "Resume from Last Point" goes (PRD section 18). The saved node when it is still live;
 * the last visited passage when that came later; otherwise the surviving-context fallback
 * (FR-STUDY-007): the nearest surviving branch root, then the starting passage, then the study's
 * list.
 * - `node`: the saved node (or, with nothing saved, the main question);
 * - `passage`: the reader at `referenceId`, in the study;
 * - `branch_root` / `starting_passage`: a fallback node;
 * - `study`: the study page with nothing selected.
 */
export const RESUME_TARGET_KINDS = [
  'node',
  'passage',
  'branch_root',
  'starting_passage',
  'study',
] as const;
export type ResumeTargetKind = (typeof RESUME_TARGET_KINDS)[number];

export const resumeTargetSchema = z.object({
  kind: z.enum(RESUME_TARGET_KINDS),
  nodeId: z.uuid().nullable(),
  referenceId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  /** True when the saved node was deleted and a fallback was used. */
  fallback: z.boolean(),
});
export type ResumeTarget = z.infer<typeof resumeTargetSchema>;

export const resumeQuestionSchema = z.object({
  nodeId: z.uuid(),
  text: z.string(),
  status: z.enum(QUESTION_STATUSES),
});

export const resumeResponseSchema = z.object({
  studyId: z.uuid(),
  title: z.string(),
  lifecycle: z.enum(['active', 'archived', 'trashed']),
  lastActivityAt: z.iso.datetime(),
  /** The saved active question when live, else the main question, else null. */
  activeQuestion: resumeQuestionSchema.nullable(),
  activeBranch: z
    .object({ id: z.uuid(), rootNodeId: z.uuid(), rootLabel: z.string().nullable() })
    .nullable(),
  /** The last deliberate visit (a `scripture_opened` event). */
  lastPassage: z
    .object({
      referenceId: z.uuid(),
      label: z.string(),
      eventId: z.uuid(),
      occurredAt: z.iso.datetime(),
    })
    .nullable(),
  /** The most recently changed live conclusion. */
  recentConclusion: z
    .object({ nodeId: z.uuid(), text: z.string(), status: z.enum(CONCLUSION_STATUSES) })
    .nullable(),
  /** Open questions in the active branch (else the study), oldest first, at most three. */
  openQuestions: z.object({
    items: z.array(z.object({ nodeId: z.uuid(), text: z.string() })),
    total: z.number().int().nonnegative(),
  }),
  target: resumeTargetSchema,
  viewState: viewStateSchema,
});
export type ResumeResponse = z.infer<typeof resumeResponseSchema>;
