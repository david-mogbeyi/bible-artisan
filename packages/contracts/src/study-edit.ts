import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { MAX_QUESTION_LENGTH, MAX_STUDY_TITLE_LENGTH, studyResponseSchema } from './study';
import {
  hasForbiddenUserTextCharacter,
  stripForbiddenUserTextCharacters,
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

/** 422: applying the tag change would leave the study with more than `MAX_STUDY_TAGS` tags. */
export const TAG_LIMIT_EXCEEDED = 'TAG_LIMIT_EXCEEDED';

/** Field-error copy. Fixed: never the submitted text. */
export const STUDY_EDIT_EMPTY =
  'Change at least one of title, description, main question, pin or tags';
export const TAG_DUPLICATE = 'Each tag must be different';
export const TAG_EMPTY = 'A tag needs at least one character';
export const TAG_TOO_LONG = `A tag can have at most ${MAX_TAG_LENGTH} characters`;
export const TOO_MANY_TAGS = `A study can have at most ${MAX_STUDY_TAGS} tags`;
export const TAG_CHANGE_EMPTY = 'Add or remove at least one tag';

/**
 * A tag's display name: Unicode NFC, trimmed, every whitespace run collapsed to one space. So
 * "  Grace  alone " (any whitespace, including a no-break space) and "Grace alone" are the
 * same tag. Shared by the API and the web form. The display name keeps the user's characters
 * otherwise (case, compatibility forms, format characters); only `tagKey` folds them.
 */
export function normalizeTagName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Unicode format characters (category Cf): zero-width space/joiners, BOM, bidi controls, etc. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * The key that makes two names the same tag for one owner (`tag.normalized_name`):
 *
 * 1. NFKC, so compatibility forms match their plain letters ("ﬁ" is "fi", full-width "Ａ" is "A").
 * 2. Format characters (\p{Cf}, e.g. U+200B zero-width space, U+200D joiner, U+FEFF) and the
 *    characters `userTextSchema` refuses are removed, so invisible variants are the same tag.
 * 3. Dotted capital İ (U+0130) and dotless ı (U+0131) become plain "i", and "i" + U+0307
 *    (combining dot above) left by case mapping becomes "i". The fold is language-neutral: a
 *    Turkish user's "ılık" and "ilik" are one tag, but "İstanbul", "Istanbul" and "istanbul"
 *    always agree, whatever locale the name was typed in.
 * 4. Case-folded with `toLowerCase().toUpperCase().toLowerCase()` (then NFKC again), which
 *    approximates full Unicode case folding: "ß" and "ẞ" become "ss", so "Straße" is "STRASSE".
 * 5. Final sigma "ς" (U+03C2) becomes "σ" (U+03C3), as Unicode case folding does. This step makes
 *    the fold context-independent: `toLowerCase` picks "ς" or "σ" for "Σ" from the letters
 *    around it, so without it "ΑΣ" alone folds to "ας" while the same letters inside "ΑΣΤΗΡ"
 *    fold to "ασ", and a library search fragment would miss the text it is part of (BIB-21).
 *    Every other step maps each character the same wherever it stands.
 * 6. Trimmed, whitespace runs collapsed to one space.
 *
 * The one fold for tag keys, library search text, search words and the title sort key: the API
 * stores the result (`tag.normalized_name`, `study.search_text`, `study.title_sort_key`), so
 * changing this function needs a data migration. Step 5 arrived with migration
 * `add_study_library`, which rewrites stored keys with `translate(…, 'ς', 'σ')`: the steps after it
 * never produce, remove or move a sigma, so that is exactly the new fold of each stored value.
 */
export function tagKey(name: string): string {
  return stripForbiddenUserTextCharacters(name.normalize('NFKC'))
    .replace(FORMAT_CHARACTERS, '')
    .replace(/[\u0130\u0131]/gu, 'i')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\u03c2/gu, '\u03c3')
    .replace(/i\u0307/gu, 'i')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * One submitted tag name. Forbidden characters are refused on the raw text (before whitespace
 * collapsing could hide a vertical tab or form feed), then the name is normalized and its length
 * checked. A name whose key is empty (only format characters, e.g. a zero-width space) is empty.
 */
export const tagNameSchema = z
  .string()
  .refine((raw) => !hasForbiddenUserTextCharacter(raw), { message: USER_TEXT_INVALID_CHARACTERS })
  .transform(normalizeTagName)
  .pipe(
    z
      .string()
      .min(1, { message: TAG_EMPTY, abort: true })
      .max(MAX_TAG_LENGTH, { message: TAG_TOO_LONG, abort: true })
      .refine((name) => tagKey(name).length > 0, { message: TAG_EMPTY }),
  );

/**
 * A change to a study's tags, as deltas, so two devices tagging the same study never clobber
 * each other's additions (a full replacement set would drop whatever the other device added):
 *
 * - `add`: tag names (normalized by `tagNameSchema`). A name whose `tagKey` the owner already has
 *   reuses that tag (keeping its stored display name); a name the study already carries is a
 *   no-op for that item.
 * - `remove`: ids of the study's tags (`StudyResponse.tags[].id`), so removal names exactly the
 *   tag the client saw, never a look-alike. An id the study does not carry (already removed,
 *   another study's, another owner's, or absent) is a no-op for that item.
 *
 * Removals apply before additions, so removing "grace" by id and adding "Grace" by name in one
 * edit recases the tag once no other study uses it. At least one item; no two adds with the same
 * key and no repeated id (400 TAG_DUPLICATE).
 */
export const tagChangeSchema = z
  .strictObject({
    add: z.array(tagNameSchema).max(MAX_STUDY_TAGS, TOO_MANY_TAGS).optional(),
    remove: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(MAX_STUDY_TAGS, TOO_MANY_TAGS)
      .optional(),
  })
  .superRefine((change, ctx) => {
    const add = change.add ?? [];
    const remove = change.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      ctx.addIssue({ code: 'custom', message: TAG_CHANGE_EMPTY });
    }
    if (new Set(add.map(tagKey)).size !== add.length) {
      ctx.addIssue({ code: 'custom', path: ['add'], message: TAG_DUPLICATE });
    }
    if (new Set(remove).size !== remove.length) {
      ctx.addIssue({ code: 'custom', path: ['remove'], message: TAG_DUPLICATE });
    }
  });

export type TagChange = z.input<typeof tagChangeSchema>;

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
 * - `tags`: `{ add?: names, remove?: tag ids }` deltas (`tagChangeSchema`). After applying them
 *   the study may carry at most 20 tags (else 422 TAG_LIMIT_EXCEEDED).
 */
export const updateStudyRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    title: userTextSchema({ max: MAX_STUDY_TITLE_LENGTH }).optional(),
    description: userTextSchema({ max: MAX_STUDY_DESCRIPTION_LENGTH }).nullable().optional(),
    mainQuestion: mainQuestionChangeSchema.optional(),
    pinned: z.boolean().optional(),
    tags: tagChangeSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (EDITABLE_FIELDS.every((field) => body[field] === undefined)) {
      ctx.addIssue({ code: 'custom', message: STUDY_EDIT_EMPTY });
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
