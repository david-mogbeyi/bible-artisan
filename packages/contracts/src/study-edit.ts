import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { MAX_QUESTION_LENGTH, MAX_STUDY_TITLE_LENGTH, studyResponseSchema } from './study';
import {
  hasForbiddenUserTextCharacter,
  USER_TEXT_INVALID_CHARACTERS,
  userTextSchema,
} from './user-text';

/**
 * Editing a study's identity, main question, pin and tags (BIB-20; PRD sections 11, 15, 23, 24;
 * FR-STUDY-003): `PATCH /v1/studies/:studyId`.
 */

/** Longest study description. The PRD sets none; this matches the edge-note bound (section 12). */
export const MAX_STUDY_DESCRIPTION_LENGTH = 2000;

/** Longest tag name, after normalization. */
export const MAX_TAG_LENGTH = 50;

/** Most tags one study can carry. */
export const MAX_STUDY_TAGS = 20;

/** 422: `mainQuestion.nodeId` is not a live Question node of this study (foreign or absent alike). */
export const QUESTION_NOT_FOUND = 'QUESTION_NOT_FOUND';

/** 422: every field in the edit already has the submitted value, so nothing was written. */
export const STUDY_UNCHANGED = 'STUDY_UNCHANGED';

/** Field-error copy. Fixed: never the submitted text. */
export const STUDY_EDIT_EMPTY =
  'Change at least one of title, description, main question, pin or tags';
export const TAG_DUPLICATE = 'Each tag must be different';
export const TAG_EMPTY = 'A tag needs at least one character';
export const TAG_TOO_LONG = `A tag can have at most ${MAX_TAG_LENGTH} characters`;
export const TOO_MANY_TAGS = `A study can have at most ${MAX_STUDY_TAGS} tags`;

/**
 * A tag's display name: Unicode NFC, trimmed, every whitespace run collapsed to one space. So
 * "  Grace  alone " (any whitespace, including a no-break space) and "Grace alone" are the
 * same tag. Shared by the API and the web form.
 */
export function normalizeTagName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * The key that makes two names the same tag for one owner (`tag.normalized_name`): the display
 * name lower-cased (`toLowerCase`, not full Unicode case folding). "Grace" and "grace" are one tag.
 */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/**
 * One submitted tag name. Forbidden characters are refused on the raw text (before whitespace
 * collapsing could hide a vertical tab or form feed), then the name is normalized and its length
 * checked.
 */
export const tagNameSchema = z
  .string()
  .refine((raw) => !hasForbiddenUserTextCharacter(raw), { message: USER_TEXT_INVALID_CHARACTERS })
  .transform(normalizeTagName)
  .pipe(z.string().min(1, TAG_EMPTY).max(MAX_TAG_LENGTH, TAG_TOO_LONG));

/**
 * The new main question: `{ text }` creates a new open Question node and makes it main;
 * `{ nodeId }` makes an existing live Question node of the same study main (e.g. the original
 * one again). Never edits a question's text, so the original question is never rewritten.
 */
export const mainQuestionChangeSchema = z.union([
  z.strictObject({ text: userTextSchema({ max: MAX_QUESTION_LENGTH }) }),
  z.strictObject({ nodeId: z.uuid().transform((id) => id.toLowerCase()) }),
]);

export type MainQuestionChange = z.infer<typeof mainQuestionChangeSchema>;

const EDITABLE_FIELDS = ['title', 'description', 'mainQuestion', 'pinned', 'tags'] as const;

/**
 * `PATCH /v1/studies/:studyId`. Strict: an unknown member is a 400, so the client can never set
 * the owner, a counter, or the original question. `expectedRevision` is the study's `revision`
 * (one revision covers every field here); without it the route answers 428 before parsing this.
 *
 * - `title`: 1–200; cannot be cleared.
 * - `description`: 1–2,000, or `null` to clear it.
 * - `tags`: the study's whole tag set (replaces it), at most 20, no two with the same `tagKey`.
 */
export const updateStudyRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    title: userTextSchema({ max: MAX_STUDY_TITLE_LENGTH }).optional(),
    description: userTextSchema({ max: MAX_STUDY_DESCRIPTION_LENGTH }).nullable().optional(),
    mainQuestion: mainQuestionChangeSchema.optional(),
    pinned: z.boolean().optional(),
    tags: z.array(tagNameSchema).max(MAX_STUDY_TAGS, TOO_MANY_TAGS).optional(),
  })
  .superRefine((body, ctx) => {
    if (EDITABLE_FIELDS.every((field) => body[field] === undefined)) {
      ctx.addIssue({ code: 'custom', message: STUDY_EDIT_EMPTY });
    }
    if (body.tags) {
      const keys = body.tags.map((name) => name.toLowerCase());
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: 'custom', path: ['tags'], message: TAG_DUPLICATE });
      }
    }
  });

export type UpdateStudyRequest = z.input<typeof updateStudyRequestSchema>;
export type ParsedUpdateStudyRequest = z.output<typeof updateStudyRequestSchema>;

/**
 * 200 from `PATCH /v1/studies/:studyId`: the study as it now stands (everything an edit can
 * change, plus the counters), and the sequence of the last event this edit appended. The
 * starting reference and creation time cannot change, so they are not repeated here.
 */
export const updateStudyResponseSchema = studyResponseSchema
  .omit({ startingReference: true, createdAt: true })
  .extend({ lastEventSequence: eventSequenceSchema });

export type UpdateStudyResponse = z.infer<typeof updateStudyResponseSchema>;
