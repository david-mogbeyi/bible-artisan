import { z } from 'zod';

/**
 * Bible reference resolution DTOs (BIB-15; PRD sections 14, 23, 24; FR-BIBLE-001..003).
 * The response never carries verse text: only the canonical, corpus-validated range.
 */

/** Longest reference input accepted (characters, after trimming). */
export const MAX_REFERENCE_INPUT_LENGTH = 200;

/** Longest range, in verses, a single reference may span (PRD section 14). */
export const MAX_REFERENCE_VERSES = 200;

export const resolveReferenceRequestSchema = z.object({
  input: z.string().trim().min(1).max(MAX_REFERENCE_INPUT_LENGTH),
  editionId: z.uuid(),
});

export type ResolveReferenceRequest = z.infer<typeof resolveReferenceRequestSchema>;

/**
 * One canonical, contiguous range within one book of one edition. `id` is stable: the same
 * edition + range always resolves to the same id, for every user.
 */
export const scriptureReferenceSchema = z.object({
  id: z.uuid(),
  editionId: z.uuid(),
  /** USFM book code, e.g. `ROM`. */
  bookCode: z.string(),
  startChapter: z.number().int().positive(),
  startVerse: z.number().int().positive(),
  endChapter: z.number().int().positive(),
  endVerse: z.number().int().positive(),
  /** Display label from the edition's book name, e.g. `Romans 8:38–9:5`. */
  label: z.string(),
});

export type ScriptureReference = z.infer<typeof scriptureReferenceSchema>;

export const referenceCandidateSchema = z.object({
  bookCode: z.string(),
  bookName: z.string(),
  /** The input to re-submit to resolve against this book (the user's numbers, unchanged). */
  input: z.string(),
});

export type ReferenceCandidate = z.infer<typeof referenceCandidateSchema>;

export const resolveReferenceResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('resolved'), reference: scriptureReferenceSchema }),
  /** The book name matched more than one book: the user picks one (FR-BIBLE-003). */
  z.object({ outcome: z.literal('ambiguous'), candidates: z.array(referenceCandidateSchema) }),
  /** Not a complete reference shape: the caller treats the input as keywords (PRD section 14). */
  z.object({ outcome: z.literal('not_reference') }),
]);

export type ResolveReferenceResponse = z.infer<typeof resolveReferenceResponseSchema>;

/** 422 error codes for a reference that cannot be resolved (FR-BIBLE-002). */
export const REFERENCE_ERROR_CODES = [
  'REFERENCE_MALFORMED',
  'REFERENCE_UNKNOWN_BOOK',
  'REFERENCE_CHAPTER_OUT_OF_RANGE',
  'REFERENCE_VERSE_OUT_OF_RANGE',
  'REFERENCE_RANGE_REVERSED',
  'REFERENCE_RANGE_TOO_LONG',
  'REFERENCE_MULTIPLE_PASSAGES',
] as const;

export type ReferenceErrorCode = (typeof REFERENCE_ERROR_CODES)[number];
