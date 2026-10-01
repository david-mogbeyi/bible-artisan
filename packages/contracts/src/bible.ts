import { z } from 'zod';
import { httpUrlSchema } from './url';

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

const resolvedReferenceOutcomeSchema = z.object({
  outcome: z.literal('resolved'),
  reference: scriptureReferenceSchema,
});
/** The book name matched more than one book: the user picks one (FR-BIBLE-003). */
const ambiguousReferenceOutcomeSchema = z.object({
  outcome: z.literal('ambiguous'),
  candidates: z.array(referenceCandidateSchema),
});

export const resolveReferenceResponseSchema = z.discriminatedUnion('outcome', [
  resolvedReferenceOutcomeSchema,
  ambiguousReferenceOutcomeSchema,
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

/**
 * Bible keyword search DTOs (BIB-16; PRD sections 14, 24; FR-BIBLE-004/005, NFR-PERF-002).
 * Query parameters arrive as strings, so `limit` is parsed from its decimal form.
 */

/** Longest search input accepted (characters, after trimming). */
export const MAX_SEARCH_QUERY_LENGTH = 200;
/** Most words (tokens) one search may contain. */
export const MAX_SEARCH_TOKENS = 20;
export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 100;
/** Longest opaque cursor accepted. */
export const MAX_SEARCH_CURSOR_LENGTH = 512;

export const SEARCH_MODES = ['terms', 'phrase'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const searchBibleQuerySchema = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  /** `terms`: every word must occur. `phrase`: the words occur together, in order. */
  mode: z.enum(SEARCH_MODES).default('terms'),
  editionId: z.uuid(),
  /** Optional USFM book code filter, e.g. `ROM`. */
  book: z
    .string()
    .regex(/^[1-4A-Z][A-Z0-9]{2}$/, 'Enter a book code such as ROM')
    .optional(),
  cursor: z
    .string()
    .max(MAX_SEARCH_CURSOR_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/, `Enter a whole number from 1 to ${MAX_SEARCH_LIMIT}`)
    .transform(Number)
    .refine((n) => n <= MAX_SEARCH_LIMIT, `Enter a whole number from 1 to ${MAX_SEARCH_LIMIT}`)
    .optional(),
});

export type SearchBibleQuery = z.infer<typeof searchBibleQuerySchema>;

/** A half-open `[start, end)` range of Unicode code points into the result's `text`. */
export const searchHighlightSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const searchResultSchema = z.object({
  /** One verse, verified against the imported corpus. */
  reference: z.object({
    bookCode: z.string(),
    chapter: z.number().int().positive(),
    verse: z.number().int().positive(),
    /** e.g. `Romans 9:1`, from the edition's book name. */
    label: z.string(),
  }),
  /** The verse text exactly as stored in the corpus (never altered or reconstructed). */
  text: z.string(),
  highlights: z.array(searchHighlightSchema),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * A terms query that is only a book name, abbreviation or code (`Job`, `Acts`, `Dan`) is searched
 * as keywords, and also offered as a reference: the book resolved exactly as
 * `POST /bible/resolve` resolves it (its first chapter), or the books it could mean. The client
 * may show "Open <Book>". Same shapes as the resolve response's `resolved` and `ambiguous`.
 */
export const searchReferenceSuggestionSchema = z.discriminatedUnion('outcome', [
  resolvedReferenceOutcomeSchema,
  ambiguousReferenceOutcomeSchema,
]);

export type SearchReferenceSuggestion = z.infer<typeof searchReferenceSuggestionSchema>;

export const searchBibleResponseSchema = z.object({
  /** Relevance order, then canonical Bible order. May hold fewer than `limit` results. */
  results: z.array(searchResultSchema),
  /** Pass back as `cursor` with the same query for the next page; null when nothing remains. */
  nextCursor: z.string().nullable(),
  /** Terms mode, book-only input: the book as a reference (on every page). Otherwise null. */
  referenceSuggestion: searchReferenceSuggestionSchema.nullable(),
});

export type SearchBibleResponse = z.infer<typeof searchBibleResponseSchema>;

/**
 * 422: the terms-mode input is a Bible reference with a chapter or verse (`Dan 3`, `Rom 9:1`), or
 * an invalid one; resolve it instead (PRD section 14). Book-only input is searched instead, with
 * a `referenceSuggestion`.
 */
export const SEARCH_QUERY_IS_REFERENCE = 'SEARCH_QUERY_IS_REFERENCE';

/**
 * Reader DTOs (BIB-17; PRD sections 11, 14, 20, 24; FR-BIBLE-007/009, NFR-PERF-001). Verse and
 * superscription text is the imported corpus's, byte for byte; nothing is reconstructed.
 */

/** Attribution shown beside every display of an edition's text (PRD section 20). */
export const bibleEditionAttributionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  abbreviation: z.string(),
  /** The publisher's attribution line, verbatim from the edition's rights record. */
  attribution: z.string(),
  /** The publisher's notice page (http/https only), or null when the edition records none. */
  noticeUrl: httpUrlSchema.nullable(),
});

export type BibleEditionAttribution = z.infer<typeof bibleEditionAttributionSchema>;

export const bibleBookSummarySchema = z.object({
  code: z.string(),
  /** The publisher's book name, e.g. `1 Corinthians`. */
  name: z.string(),
  chapterCount: z.number().int().positive(),
});

export type BibleBookSummary = z.infer<typeof bibleBookSummarySchema>;

export const bibleTranslationSchema = bibleEditionAttributionSchema.extend({
  code: z.string(),
  language: z.string(),
  /** Every book of the edition, in canon order. */
  books: z.array(bibleBookSummarySchema),
});

export type BibleTranslation = z.infer<typeof bibleTranslationSchema>;

export const bibleTranslationsResponseSchema = z.object({
  /** Active editions only. */
  translations: z.array(bibleTranslationSchema),
});

export type BibleTranslationsResponse = z.infer<typeof bibleTranslationsResponseSchema>;

/**
 * `GET /bible/passages`: one chapter, the reading context (PRD section 11): the chapter holding
 * the reference's start, with the reference. The reference fixes the edition, so a bookmarked
 * `referenceId` always opens the same edition. `editionId` (PRD section 24) is optional; when
 * given it must be the reference's edition, else 404. Only opaque ids travel in the URL, so no
 * Scripture reference appears in any request log (NFR-PRIV-001).
 */
export const biblePassageQuerySchema = z.object({
  referenceId: z.uuid(),
  editionId: z.uuid().optional(),
});

export type BiblePassageQuery = z.infer<typeof biblePassageQuerySchema>;

/** A neighboring chapter, with the id of its whole-chapter reference: one request to open it. */
export const bibleChapterLinkSchema = z.object({
  bookCode: z.string(),
  bookName: z.string(),
  chapter: z.number().int().positive(),
  /** The whole chapter's shared `scripture_reference` id (same identity as `POST /bible/resolve`). */
  referenceId: z.uuid(),
});

export type BibleChapterLink = z.infer<typeof bibleChapterLinkSchema>;

export const biblePassageResponseSchema = z.object({
  edition: bibleEditionAttributionSchema,
  book: bibleBookSummarySchema,
  chapter: z.number().int().positive(),
  /**
   * Every verse of the chapter in order, text exactly as stored. A verse the edition numbers but
   * gives no text for has `text: ''`; it is returned, never dropped or filled.
   */
  verses: z.array(z.object({ verse: z.number().int().positive(), text: z.string() })),
  /** The publisher's superscriptions (Psalm titles, stanza headings), never part of a verse. */
  superscriptions: z.array(
    z.object({ beforeVerse: z.number().int().positive(), text: z.string() }),
  ),
  /** The requested reference (it may continue into later chapters). */
  reference: scriptureReferenceSchema,
  /** Neighboring chapters in canon order, across books; null at either end of the canon. */
  previous: bibleChapterLinkSchema.nullable(),
  next: bibleChapterLinkSchema.nullable(),
});

export type BiblePassageResponse = z.infer<typeof biblePassageResponseSchema>;

/** Highest chapter or verse number accepted before the corpus check (Psalms has 150 chapters). */
export const MAX_CHAPTER_OR_VERSE = 999;

/**
 * `POST /bible/references`: the reference for a chapter, or one verse of it, chosen by structure
 * (the book/chapter picker, a translation change, a search result), validated against the
 * edition's corpus with no text parsing. Without `verse` it is the whole chapter, the same shared
 * reference `POST /bible/resolve` gives for that chapter. A book, chapter or verse the edition
 * lacks is 422 with a reference error code, never the nearest one that exists.
 */
export const bibleReferenceRequestSchema = z.object({
  editionId: z.uuid(),
  /** USFM book code, e.g. `ROM`. */
  bookCode: z.string().regex(/^[1-4A-Z][A-Z0-9]{2}$/, 'Enter a book code such as ROM'),
  chapter: z.number().int().positive().max(MAX_CHAPTER_OR_VERSE),
  verse: z.number().int().positive().max(MAX_CHAPTER_OR_VERSE).optional(),
});

export type BibleReferenceRequest = z.infer<typeof bibleReferenceRequestSchema>;

export const bibleReferenceResponseSchema = z.object({ reference: scriptureReferenceSchema });

export type BibleReferenceResponse = z.infer<typeof bibleReferenceResponseSchema>;
