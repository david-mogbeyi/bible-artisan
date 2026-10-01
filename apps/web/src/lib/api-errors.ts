import {
  MAX_REFERENCE_VERSES,
  REFERENCE_ERROR_CODES,
  type ReferenceErrorCode,
} from '@bible-artisan/contracts';
import { ApiError } from './api-client';

/**
 * How the UI treats a failed request (PRD section 24 error envelope). Copy is chosen from the
 * status and `code` only: a server `message` is never rendered.
 */
export type ErrorKind =
  /** 401: the session ended; the page sends the user to sign in. */
  | { kind: 'unauthenticated' }
  /** 404: nothing to retry; never substitute another passage. */
  | { kind: 'not_found' }
  /** 422 with a reference error code: the reference cannot exist. */
  | { kind: 'reference'; code: ReferenceErrorCode }
  /** 429: retry, after `Retry-After` seconds when the server sent it. */
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** 503 or a server/network failure, or an envelope marked `retryable`: Retry. */
  | { kind: 'unavailable'; retryAfterSeconds?: number }
  /** Any other refusal (4xx, `retryable: false`): retrying the same request cannot help. */
  | { kind: 'refused' };

const REFERENCE_CODES: ReadonlySet<string> = new Set(REFERENCE_ERROR_CODES);

function isReferenceCode(code: string | undefined): code is ReferenceErrorCode {
  return code !== undefined && REFERENCE_CODES.has(code);
}

export function classifyError(error: unknown): ErrorKind {
  // Not an API response (offline, a dropped connection, a response that failed its schema).
  if (!(error instanceof ApiError)) return { kind: 'unavailable' };
  const retryAfter =
    error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {};
  if (error.status === 401) return { kind: 'unauthenticated' };
  if (error.status === 404) return { kind: 'not_found' };
  if (error.status === 429) return { kind: 'rate_limited', ...retryAfter };
  if (error.status === 422 && isReferenceCode(error.code)) {
    return { kind: 'reference', code: error.code };
  }
  const body = error.body as { retryable?: unknown } | null | undefined;
  if (error.status >= 500 || body?.retryable === true)
    return { kind: 'unavailable', ...retryAfter };
  return { kind: 'refused' };
}

export const isRetryable = (kind: ErrorKind): boolean =>
  kind.kind === 'rate_limited' || kind.kind === 'unavailable';

/** Fixed copy for each reference error code (never the server's message, never the input). */
export const REFERENCE_ERROR_COPY: Record<ReferenceErrorCode, string> = {
  REFERENCE_MALFORMED: 'That is not a complete Bible reference.',
  REFERENCE_UNKNOWN_BOOK: 'No book in this translation matches that name.',
  REFERENCE_CHAPTER_OUT_OF_RANGE: 'That chapter does not exist in this book.',
  REFERENCE_VERSE_OUT_OF_RANGE: 'That verse does not exist in this chapter.',
  REFERENCE_RANGE_REVERSED: 'The passage ends before it starts.',
  REFERENCE_RANGE_TOO_LONG: `A passage can span at most ${MAX_REFERENCE_VERSES} verses.`,
  REFERENCE_MULTIPLE_PASSAGES: 'Enter one passage from one book at a time.',
};
