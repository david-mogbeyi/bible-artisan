import { z } from 'zod';
import { resolveAnchorResponseSchema, scriptureAnchorSchema } from './anchor';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';

/**
 * Highlights (BIB-24; PRD sections 14, 15, 23, 24; FR-BIBLE-006/007). A highlight is an
 * `Annotation`: a durable anchor (BIB-18's `scriptureAnchorSchema`, re-checked by the server
 * against the corpus on every create and every read) in one of four named colors, with an optional
 * label. It is bound to the edition it was made on and is never moved to other text: an anchor
 * that no longer matches is reported as unresolved, with its original quote.
 */

/** PRD section 15: "four named colors". Stored as these tokens (CHECK-constrained). */
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** What each color is called wherever it is shown, so color is never the only signal (WCAG). */
export const HIGHLIGHT_COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
};

/** Longest optional label, in code points (as `char_length` counts them). */
export const MAX_HIGHLIGHT_LABEL_LENGTH = 80;
/** Live (not deleted) highlights one study may hold. */
export const MAX_ANNOTATIONS_PER_STUDY = 2000;

/** 422: the study already holds `MAX_ANNOTATIONS_PER_STUDY` live highlights. */
export const ANNOTATION_LIMIT_EXCEEDED = 'ANNOTATION_LIMIT_EXCEEDED';
/** 422: the edit changes nothing (same color and label). */
export const ANNOTATION_UNCHANGED = 'ANNOTATION_UNCHANGED';

export const ANNOTATION_ERROR_CODES = [ANNOTATION_LIMIT_EXCEEDED, ANNOTATION_UNCHANGED] as const;
export type AnnotationErrorCode = (typeof ANNOTATION_ERROR_CODES)[number];

export const HIGHLIGHT_LABEL_TOO_LONG = `A label can have at most ${MAX_HIGHLIGHT_LABEL_LENGTH} characters`;
export const HIGHLIGHT_LABEL_INVALID = 'Remove control or invalid characters';
export const HIGHLIGHT_EDIT_EMPTY = 'Send a new color or label';

// C0/C1 controls, U+2028/9 and lone surrogates: a label is one line of plain text.
const FORBIDDEN_LABEL_TEXT =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * An optional label: trimmed, one line, at most `MAX_HIGHLIGHT_LABEL_LENGTH` code points. Empty
 * after trimming means no label (null), so clearing the field removes it.
 */
export const highlightLabelSchema = z
  .string()
  .trim()
  .refine((text) => !FORBIDDEN_LABEL_TEXT.test(text), { message: HIGHLIGHT_LABEL_INVALID })
  .refine((text) => Array.from(text).length <= MAX_HIGHLIGHT_LABEL_LENGTH, {
    message: HIGHLIGHT_LABEL_TOO_LONG,
  })
  .transform((text) => (text === '' ? null : text))
  .nullable();

/**
 * `POST /v1/studies/:studyId/annotations`. Creating a highlight is a change to the study, so
 * `expectedRevision` is the study's revision. `anchor` is what `POST /bible/anchors` returned;
 * the server re-checks every part of it (checksums included) and stores it unchanged.
 */
export const createAnnotationRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  anchor: scriptureAnchorSchema,
  colorToken: z.enum(HIGHLIGHT_COLORS),
  label: highlightLabelSchema.optional(),
});

export type CreateAnnotationRequest = z.input<typeof createAnnotationRequestSchema>;

/** `PATCH …/annotations/:annotationId`: the highlight's revision and a new color and/or label. */
export const updateAnnotationRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    colorToken: z.enum(HIGHLIGHT_COLORS).optional(),
    label: highlightLabelSchema.optional(),
  })
  .refine((body) => body.colorToken !== undefined || body.label !== undefined, {
    message: HIGHLIGHT_EDIT_EMPTY,
  });

export type UpdateAnnotationRequest = z.input<typeof updateAnnotationRequestSchema>;

/** `DELETE …/annotations/:annotationId`: the highlight's revision. */
export const annotationStateRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
});

/**
 * `GET /v1/studies/:studyId/annotations?referenceId=`: the study's highlights on the chapter the
 * reader shows for that reference (its first chapter), in the reference's edition and book. Only
 * an opaque id travels in the URL, never a book, chapter or quote.
 */
export const listAnnotationsQuerySchema = z.strictObject({ referenceId: z.uuid() });

/**
 * One highlight as read. `resolution` is the anchor re-checked against the corpus on this read,
 * in the shape of `POST /bible/anchors/resolve`: `resolved` with the anchor unchanged, or
 * `unresolved` with the reason and the anchor exactly as stored (its original quote). The reader
 * draws only resolved highlights, and only on the edition they were made on.
 */
export const annotationSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  colorToken: z.enum(HIGHLIGHT_COLORS),
  label: z.string().nullable(),
  resolution: resolveAnchorResponseSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Annotation = z.infer<typeof annotationSchema>;

/** Oldest first (ties by id), so a later highlight is drawn over an earlier one. */
export const annotationListResponseSchema = z.object({ items: z.array(annotationSchema) });

export type AnnotationListResponse = z.infer<typeof annotationListResponseSchema>;

/**
 * 200 from `PATCH` and `DELETE`: the highlight's new state without its anchor or label. Every
 * mutation response is stored on its Idempotency-Key receipt, and the client already holds what it
 * sent, so quotes and labels never reach `mutation_receipt`.
 */
export const annotationMutationResponseSchema = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  revision: z.number().int().positive(),
  colorToken: z.enum(HIGHLIGHT_COLORS),
  /** The shared reference covering the anchor's verses. */
  referenceId: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  lastEventSequence: eventSequenceSchema,
});

export type AnnotationMutationResponse = z.infer<typeof annotationMutationResponseSchema>;

/** 201 from `POST`: as above, plus the study revision the creation moved to. */
export const createAnnotationResponseSchema = annotationMutationResponseSchema.extend({
  studyRevision: z.number().int().positive(),
});

export type CreateAnnotationResponse = z.infer<typeof createAnnotationResponseSchema>;
