import { z } from 'zod';
import { MAX_CHAPTER_OR_VERSE, MAX_REFERENCE_VERSES, scriptureReferenceSchema } from './bible';

/**
 * Durable Scripture anchors (BIB-18; PRD sections 11, 14, 15, 23; FR-BIBLE-006). An anchor is a
 * value, not a row: BIB-24 stores it as `Annotation.anchor_json`. It names an edition, a book and
 * one segment per verse; each segment is a half-open `[start, end)` range of Unicode code points
 * into that verse's stored text (the same unit as search highlights, never DOM or UTF-16 offsets),
 * with the verse's `text_sha256` at capture. The server builds and re-checks every anchor against
 * the immutable corpus, and never repairs one: a mismatch is reported, not moved.
 */

/** Longest verse text is 491 code points; offsets above this are malformed, not merely wrong. */
export const MAX_ANCHOR_OFFSET = 2000;

/**
 * Longest quote accepted. The longest run of 200 consecutive verses in the corpus is 35,606
 * characters (36,196 UTF-8 bytes), so every real anchor fits, and a request stays well under the
 * API's 100 kB JSON body limit (413 above it).
 */
export const MAX_ANCHOR_QUOTE_LENGTH = 40_000;

export const ANCHOR_KINDS = ['verses', 'phrase'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

const bookCodeSchema = z.string().regex(/^[1-4A-Z][A-Z0-9]{2}$/, 'Enter a book code such as ROM');
const offsetSchema = z.number().int().nonnegative().max(MAX_ANCHOR_OFFSET);

const segmentShape = {
  chapter: z.number().int().positive().max(MAX_CHAPTER_OR_VERSE),
  verse: z.number().int().positive().max(MAX_CHAPTER_OR_VERSE),
  /** Code points into the verse's stored text, inclusive. */
  start: offsetSchema,
  /** Code points into the verse's stored text, exclusive. */
  end: offsetSchema,
};

const startNotAfterEnd = (s: { start: number; end: number }) => s.start <= s.end;
const ORDER_MESSAGE = 'A segment cannot end before it starts';

export const anchorSelectionSegmentSchema = z
  .object(segmentShape)
  .refine(startNotAfterEnd, { message: ORDER_MESSAGE, path: ['end'] });

export const scriptureAnchorSegmentSchema = z
  .object({ ...segmentShape, textSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .refine(startNotAfterEnd, { message: ORDER_MESSAGE, path: ['end'] });

const anchorShape = {
  editionId: z.uuid(),
  /** USFM book code; an anchor never crosses books. */
  bookCode: bookCodeSchema,
  /** `verses`: whole verses (checkboxes). `phrase`: contiguous text, possibly across verses. */
  kind: z.enum(ANCHOR_KINDS),
  /**
   * The selected text exactly: the non-empty segment slices joined with one U+0020 space (see
   * `joinAnchorQuote`). Verse text never holds line breaks or doubled spaces, so this is
   * unambiguous given the segments.
   */
  quote: z.string().max(MAX_ANCHOR_QUOTE_LENGTH),
};

/** `POST /bible/anchors`: what the reader selected. The server adds the checksums. */
export const anchorSelectionSchema = z.object({
  ...anchorShape,
  /** One per verse, consecutive in canon order (at most 200, the reference cap). */
  segments: z.array(anchorSelectionSegmentSchema).min(1).max(MAX_REFERENCE_VERSES),
});

export type AnchorSelection = z.infer<typeof anchorSelectionSchema>;

/** A durable anchor (version 1), as stored by the features that keep one. */
export const scriptureAnchorSchema = z.object({
  version: z.literal(1),
  ...anchorShape,
  segments: z.array(scriptureAnchorSegmentSchema).min(1).max(MAX_REFERENCE_VERSES),
});

export type ScriptureAnchor = z.infer<typeof scriptureAnchorSchema>;

/**
 * Why an anchor does not match the corpus. `POST /bible/anchors` answers 422 with one of these as
 * the envelope `code`; `POST /bible/anchors/resolve` returns one as `reason`. Messages are fixed
 * and echo nothing.
 */
export const ANCHOR_PROBLEM_CODES = [
  /** The anchor's edition is unknown or not active (resolve only; capture answers 404). */
  'ANCHOR_EDITION_UNAVAILABLE',
  /** A segment names a book, chapter or verse the edition lacks. */
  'ANCHOR_VERSE_NOT_FOUND',
  /** Segments are not consecutive verses, or a phrase's text has a gap. */
  'ANCHOR_NOT_CONTIGUOUS',
  /** A verse's stored checksum differs from the anchor's (resolve only). */
  'ANCHOR_CHECKSUM_MISMATCH',
  /** An offset is beyond the verse's text. */
  'ANCHOR_OFFSET_OUT_OF_RANGE',
  /** `kind: 'verses'` but a segment is not a whole verse. */
  'ANCHOR_KIND_MISMATCH',
  /** A phrase starts or ends on an empty segment. */
  'ANCHOR_EMPTY',
  /** The quote is not exactly the stored text at those offsets. */
  'ANCHOR_QUOTE_MISMATCH',
] as const;

export type AnchorProblemCode = (typeof ANCHOR_PROBLEM_CODES)[number];

export const captureAnchorResponseSchema = z.object({
  anchor: scriptureAnchorSchema,
  /** The shared reference covering the anchor's first through last verse (for display and links). */
  reference: scriptureReferenceSchema,
});

export type CaptureAnchorResponse = z.infer<typeof captureAnchorResponseSchema>;

/** `POST /bible/anchors/resolve`: re-check a stored anchor against the corpus. */
export const resolveAnchorRequestSchema = z.object({ anchor: scriptureAnchorSchema });

export type ResolveAnchorRequest = z.infer<typeof resolveAnchorRequestSchema>;

export const resolveAnchorResponseSchema = z.discriminatedUnion('outcome', [
  /** Every segment still matches: the anchor is returned unchanged. */
  z.object({
    outcome: z.literal('resolved'),
    anchor: scriptureAnchorSchema,
    reference: scriptureReferenceSchema,
  }),
  /**
   * The anchor no longer matches. It is returned exactly as sent (its quote is the original
   * selection); nothing is moved to nearby offsets or verses. `reference` is the anchor's verse
   * range when it still exists in an active edition, so the reader can reopen it to reselect.
   */
  z.object({
    outcome: z.literal('unresolved'),
    reason: z.enum(ANCHOR_PROBLEM_CODES),
    anchor: scriptureAnchorSchema,
    reference: scriptureReferenceSchema.nullable(),
  }),
]);

export type ResolveAnchorResponse = z.infer<typeof resolveAnchorResponseSchema>;

/** The quote rule, shared by the reader and the server: non-empty slices joined by one space. */
export function joinAnchorQuote(slices: readonly string[]): string {
  return slices.filter((s) => s !== '').join(' ');
}
