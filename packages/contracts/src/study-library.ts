import { z } from 'zod';
import { scriptureReferenceSchema } from './bible';
import { STUDY_LIFECYCLES, studyTagSchema } from './study';
import { tagKey } from './study-edit';
import { userTextSchema } from './user-text';

/**
 * The study library (BIB-21; PRD sections 9, 11, 23, 24; FR-STUDY-004): `GET /v1/studies` lists,
 * searches, filters and sorts the signed-in user's own studies, pinned first, in keyset pages.
 * Query parameters arrive as strings, so `limit` is parsed from its decimal form.
 */

/** Longest library search input (characters, after trimming). */
export const MAX_LIBRARY_QUERY_LENGTH = 200;
/** Most words one library search may contain. */
export const MAX_LIBRARY_QUERY_TOKENS = 10;
/** PRD section 11: "Default lists the latest 50 with cursor pagination". */
export const DEFAULT_LIBRARY_LIMIT = 50;
export const MAX_LIBRARY_LIMIT = 50;
/**
 * Code points of the folded title that `sort=title` orders by (`studyTitleSortKey`). Titles whose
 * folded forms agree this far tie, and their order falls to the study id.
 */
export const TITLE_SORT_KEY_LENGTH = 200;
/**
 * Longest opaque cursor accepted. A `title` cursor carries, encrypted, the sort key of the
 * previous page's last study (at most `TITLE_SORT_KEY_LENGTH` code points, 4 UTF-8 bytes each)
 * plus about 150 bytes of position, binding and encryption overhead; base64url makes 4
 * characters of every 3 bytes. 2,048 covers the largest with room to spare.
 */
export const MAX_LIBRARY_CURSOR_LENGTH = 2048;

/** PRD section 11: "recent/title/created sorting". `recent` is by last activity. */
export const STUDY_SORTS = ['recent', 'created', 'title'] as const;
export type StudySort = (typeof STUDY_SORTS)[number];

/**
 * Lifecycles the library lists: one state per listing. `trashed` is the Trash view (BIB-22): it
 * lists only studies still inside their recovery window.
 */
export const LIBRARY_STATES = ['active', 'archived', 'trashed'] as const;
export type LibraryState = (typeof LIBRARY_STATES)[number];

/** Field-error copy. Fixed: never the submitted text. */
export const LIBRARY_QUERY_EMPTY = 'Enter at least one letter or number';
export const LIBRARY_QUERY_TOO_MANY_WORDS = `Search for at most ${MAX_LIBRARY_QUERY_TOKENS} words`;
export const LIBRARY_CURSOR_INVALID = 'Invalid cursor';

/**
 * The words of a library search, folded exactly as stored text is (`tagKey`: NFKC, invisible
 * characters removed, language-neutral case folding, whitespace collapsed), distinct and in typed
 * order. A study matches when every word is a substring of its folded title or description, or of
 * one of its tags' keys. Matching is literal: punctuation, `%`, `_`, `*` and quotes are ordinary
 * characters.
 */
export function studySearchTokens(q: string): string[] {
  const words = tagKey(q)
    .split(' ')
    .filter((word) => word.length > 0);
  return [...new Set(words)];
}

/**
 * `study.search_text`: the folded title and description, one per line. Folding removes line
 * breaks inside each part, and a search word never contains whitespace, so a word cannot match
 * across the two. Written by the API wherever the title or description is written.
 */
export function studySearchText(title: string, description: string | null): string {
  return description === null ? tagKey(title) : `${tagKey(title)}\n${tagKey(description)}`;
}

/**
 * `study.title_sort_key`, what `sort=title` orders by (in `COLLATE "C"`, then id): the folded
 * title (`tagKey`, so case, compatibility forms and final sigma never decide the order), cut to
 * its first `TITLE_SORT_KEY_LENGTH` code points so a cursor that carries it stays small. Written
 * by the API wherever the title is written; the order never depends on the database collation.
 */
export function studyTitleSortKey(title: string): string {
  return Array.from(tagKey(title)).slice(0, TITLE_SORT_KEY_LENGTH).join('');
}

/** Query-string booleans. */
const flagSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listStudiesQuerySchema = z.strictObject({
  q: userTextSchema({ max: MAX_LIBRARY_QUERY_LENGTH })
    .superRefine((q, ctx) => {
      // Length is already reported; one issue per problem.
      if (q.length === 0 || q.length > MAX_LIBRARY_QUERY_LENGTH) return;
      const count = studySearchTokens(q).length;
      if (count === 0) ctx.addIssue({ code: 'custom', message: LIBRARY_QUERY_EMPTY });
      else if (count > MAX_LIBRARY_QUERY_TOKENS) {
        ctx.addIssue({ code: 'custom', message: LIBRARY_QUERY_TOO_MANY_WORDS });
      }
    })
    .optional(),
  /** One of the owner's tag ids. Another user's or an absent id simply matches nothing. */
  tag: z.uuid().optional(),
  state: z.enum(LIBRARY_STATES).default('active'),
  sort: z.enum(STUDY_SORTS).default('recent'),
  /**
   * `true` (the library): pinned studies first, then the rest, each group in `sort` order.
   * `false` (Home's "Recent studies", PRD section 11): one list in `sort` order, pins ignored.
   */
  pinnedFirst: flagSchema.default(true),
  cursor: z
    .string()
    .max(MAX_LIBRARY_CURSOR_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/, LIBRARY_CURSOR_INVALID)
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]?$/, `Enter a whole number from 1 to ${MAX_LIBRARY_LIMIT}`)
    .transform(Number)
    .refine((n) => n <= MAX_LIBRARY_LIMIT, `Enter a whole number from 1 to ${MAX_LIBRARY_LIMIT}`)
    .default(DEFAULT_LIBRARY_LIMIT),
});

export type ListStudiesQuery = z.input<typeof listStudiesQuerySchema>;
export type ParsedListStudiesQuery = z.output<typeof listStudiesQuerySchema>;

/** One library card: what PRD section 11 lists (title, starting passage, last activity, tags, pin). */
export const studyListItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  pinned: z.boolean(),
  lifecycle: z.enum(STUDY_LIFECYCLES),
  startingReference: scriptureReferenceSchema.nullable(),
  /** Sorted by normalized name, as on `GET /studies/:id`. */
  tags: z.array(studyTagSchema),
  lastActivityAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  /** As on `GET /studies/:id`: when a trashed study is permanently deleted, else null. */
  purgeAt: z.iso.datetime().nullable(),
  /**
   * True when the listing has a search (`q`) and at least one of its words occurs in a live note
   * of the study (BIB-23), so the card can say it was found in the notes (PRD section 14:
   * "separate result labels"). Always false without `q`.
   */
  matchedInNotes: z.boolean(),
});

export type StudyListItem = z.infer<typeof studyListItemSchema>;

/**
 * One page. With `pinnedFirst` (the default) pinned studies come first (`pinned: true`), then the
 * rest, each group in the chosen sort; without it, every study in the chosen sort. `nextCursor` is non-null exactly when more studies follow. No totals: a count is not
 * needed by the UI and is one more thing that could leak.
 */
export const studyListResponseSchema = z.object({
  items: z.array(studyListItemSchema),
  nextCursor: z.string().nullable(),
});

export type StudyListResponse = z.infer<typeof studyListResponseSchema>;
