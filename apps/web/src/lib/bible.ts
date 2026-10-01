import {
  biblePassageResponseSchema,
  bibleTranslationsResponseSchema,
  resolveReferenceResponseSchema,
  searchBibleResponseSchema,
  type BibleBookSummary,
  type BiblePassageResponse,
  type BibleTranslationsResponse,
  type ResolveReferenceResponse,
  type SearchBibleResponse,
  type SearchMode,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Reader data access (BIB-17). The reader is always positioned on a resolved reference: an opaque
 * `scripture_reference` id. Chapters and verses are reached by resolving their text through
 * `POST /bible/resolve` (a request body, never logged), so no Scripture reference appears in any
 * page or API URL, browser history entry, or request log (NFR-PRIV-001).
 */

export interface SearchRequest {
  q: string;
  mode: SearchMode;
  editionId: string;
  book?: string;
}

export const TRANSLATIONS_QUERY_KEY = ['bible', 'translations'] as const;

export function fetchTranslations(): Promise<BibleTranslationsResponse> {
  return apiFetch('/bible/translations', bibleTranslationsResponseSchema);
}

export function passageQueryKey(editionId: string, referenceId: string) {
  return ['bible', 'passage', editionId, referenceId] as const;
}

export function fetchPassage(
  editionId: string,
  referenceId: string,
): Promise<BiblePassageResponse> {
  const params = new URLSearchParams({ editionId, referenceId });
  return apiFetch(`/bible/passages?${params.toString()}`, biblePassageResponseSchema);
}

export function resolveReference(
  input: string,
  editionId: string,
): Promise<ResolveReferenceResponse> {
  return apiFetch('/bible/resolve', resolveReferenceResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ input, editionId }),
  });
}

export function searchBible(
  request: SearchRequest,
  cursor: string | null,
): Promise<SearchBibleResponse> {
  const params = new URLSearchParams({
    q: request.q,
    mode: request.mode,
    editionId: request.editionId,
  });
  if (request.book) params.set('book', request.book);
  if (cursor) params.set('cursor', cursor);
  return apiFetch(`/bible/search?${params.toString()}`, searchBibleResponseSchema);
}

/**
 * The text that resolves to one whole chapter: the book's name and the chapter, or the name alone
 * for a single-chapter book (where a bare number is a verse). The API suite proves this resolves
 * to exactly that chapter for every chapter of the corpus.
 */
export function chapterInput(book: BibleBookSummary, chapter: number): string {
  return book.chapterCount === 1 ? book.name : `${book.name} ${chapter}`;
}

/** The text that resolves to one verse. */
export function verseInput(book: BibleBookSummary, chapter: number, verse: number): string {
  return `${book.name} ${chapter}:${verse}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed id from `/bible` query parameters, or null. */
export function idFromParams(params: URLSearchParams, name: 'ref' | 'edition'): string | null {
  const value = params.get(name);
  return value !== null && UUID.test(value) ? value : null;
}

/**
 * The `/bible` URL: opaque ids only. The edition is included only when it is not the default.
 * Search text and references never go in the URL (PRD section 9, NFR-PRIV-001).
 */
export function bibleHref(
  referenceId: string | null,
  editionId: string | null,
  defaultEditionId: string | null,
): string {
  const params = new URLSearchParams();
  if (editionId && editionId !== defaultEditionId) params.set('edition', editionId);
  if (referenceId) params.set('ref', referenceId);
  const query = params.toString();
  return query ? `/bible?${query}` : '/bible';
}
