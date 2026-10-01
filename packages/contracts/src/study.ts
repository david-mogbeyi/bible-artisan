import { z } from 'zod';
import { scriptureReferenceSchema } from './bible';
import { eventSequenceSchema } from './mutation';
import { userTextSchema } from './user-text';

/**
 * Study creation and read DTOs (BIB-19; PRD sections 10, 11, 23, 24; FR-STUDY-001/002).
 */

/** Longest study title (PRD section 15: "title to 200"). */
export const MAX_STUDY_TITLE_LENGTH = 200;

/** Longest question statement (PRD section 15: "question/conclusion statements to 4,000"). */
export const MAX_QUESTION_LENGTH = 4000;

/** The title of an explicit Blank Study (PRD section 11: "creates an untitled empty workspace"). */
export const UNTITLED_STUDY_TITLE = 'Untitled study';

/** 422: the starting reference id is unknown, or its edition is not active. */
export const REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND';

/** Field-error messages for the creation rules. Fixed copy: never the submitted content. */
export const STUDY_START_REQUIRED = 'Add a question or a starting passage, or start a blank study';
export const BLANK_STUDY_HAS_CONTENT = 'A blank study has no question or starting passage';

/**
 * `POST /v1/studies`. Strict: an unknown member (an owner, a revision, a sequence) is a 400, so
 * the client can never choose anything the server owns. There is no `expectedRevision`: a new
 * study has nothing to compare against, so 428 never applies.
 *
 * Either at least one of `question` / `startingReferenceId`, or an explicit `blank: true` with
 * neither. `startingReferenceId` is a shared `scripture_reference` id from `POST /bible/resolve`
 * or `POST /bible/references`; it fixes the edition.
 */
export const createStudyRequestSchema = z
  .strictObject({
    title: userTextSchema({ max: MAX_STUDY_TITLE_LENGTH }).optional(),
    question: userTextSchema({ max: MAX_QUESTION_LENGTH }).optional(),
    startingReferenceId: z.uuid().optional(),
    blank: z.literal(true).optional(),
  })
  .superRefine((body, ctx) => {
    const hasStart = body.question !== undefined || body.startingReferenceId !== undefined;
    if (body.blank === true && hasStart) {
      ctx.addIssue({ code: 'custom', path: ['blank'], message: BLANK_STUDY_HAS_CONTENT });
    } else if (body.blank === undefined && !hasStart) {
      // Not one field's fault: reported at the root (`_` in `fieldErrors`).
      ctx.addIssue({ code: 'custom', message: STUDY_START_REQUIRED });
    }
  });

export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;

/**
 * 201 from `POST /v1/studies` (PRD section 24). Every root created in the one transaction shares
 * revision 1 and content revision 1. `rootNodeId` is the starting passage's Scripture node.
 * The PRD example's `sessionId` arrives with sessions (BIB-33).
 */
export const createStudyResponseSchema = z.object({
  studyId: z.uuid(),
  revision: z.number().int().positive(),
  contentRevision: z.number().int().positive(),
  rootNodeId: z.uuid().nullable(),
  questionNodeId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  lastEventSequence: eventSequenceSchema,
});

export type CreateStudyResponse = z.infer<typeof createStudyResponseSchema>;

export const STUDY_LIFECYCLES = ['active', 'archived', 'trashed'] as const;

export const QUESTION_STATUSES = ['open', 'partially_answered', 'answered', 'deferred'] as const;

/** `GET /v1/studies/:studyId`: what creation wrote, for the study page and reload. */
export const studyResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  lifecycle: z.enum(STUDY_LIFECYCLES),
  revision: z.number().int().positive(),
  contentRevision: z.number().int().positive(),
  startingReference: scriptureReferenceSchema.nullable(),
  mainQuestion: z
    .object({ nodeId: z.uuid(), text: z.string(), status: z.enum(QUESTION_STATUSES) })
    .nullable(),
  branchId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type StudyResponse = z.infer<typeof studyResponseSchema>;
