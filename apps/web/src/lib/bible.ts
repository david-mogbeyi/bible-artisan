import {
  biblePassageResponseSchema,
  bibleReferenceResponseSchema,
  bibleTranslationsResponseSchema,
  resolveReferenceResponseSchema,
  searchBibleResponseSchema,
  type BibleReferenceRequest,
  type BiblePassageResponse,
  type BibleTranslationsResponse,
  type ResolveReferenceResponse,
  type ScriptureReference,
  type SearchBibleResponse,
  type SearchMode,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Reader data access (BIB-17). The reader is always positioned on a resolved reference: an opaque
 * `scripture_reference` id, which also fixes the edition. Typed text is resolved through
 * `POST /bible/resolve`; a chapter or verse chosen by structure (picker, translation change,
 * search result) through `POST /bible/references`; previous/next links already carry their id.
 * Request bodies are never logged, so no Scripture reference appears in any page or API URL,
 * browser history entry, or request log (NFR-PRIV-001).
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

export function passageQueryKey(referenceId: string) {
  return ['bible', 'passage', referenceId] as const;
}

/** The chapter holding the reference; the reference fixes the edition. */
export function fetchPassage(referenceId: string): Promise<BiblePassageResponse> {
  const params = new URLSearchParams({ referenceId });
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

/** A whole chapter, or one verse of it, chosen by structure (no text, no client-side rules). */
export type ChapterTarget = BibleReferenceRequest;

export async function referenceFor(target: ChapterTarget): Promise<ScriptureReference> {
  const { reference } = await apiFetch('/bible/references', bibleReferenceResponseSchema, {
    method: 'POST',
    body: JSON.stringify(target),
  });
  return reference;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The well-formed reference id from the `/bible` query parameters, or null. */
export function referenceIdFromParams(params: URLSearchParams): string | null {
  const value = params.get('ref');
  return value !== null && UUID.test(value) ? value : null;
}

/**
 * The `/bible` URL: the opaque reference id only. The reference fixes the edition, so a bookmark
 * keeps opening the same edition whichever editions are active. Search text and references never
 * go in the URL (PRD section 9, NFR-PRIV-001).
 */
export function bibleHref(referenceId: string | null): string {
  return referenceId ? `/bible?${new URLSearchParams({ ref: referenceId }).toString()}` : '/bible';
}
