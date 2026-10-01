import { createHash } from 'node:crypto';
import type { SearchQuery } from './search-text';

/**
 * Opaque keyset cursor for search pages (BIB-16). It holds the last scanned candidate's sort key
 * (rank, then canonical position) and a fingerprint of the query it belongs to, so a cursor
 * cannot be replayed against a different query, edition, book filter or mode. It carries no
 * query text, only a truncated hash of it.
 */
export interface CursorPosition {
  /** `ts_rank` as PostgreSQL printed it (via float8), so it reads back as the same float4. */
  rank: string;
  sequence: number;
  chapter: number;
  verse: number;
}

const VERSION = 1;
/** A non-negative float as PostgreSQL prints a double (`0.06079270318150520`, `6.07927e-05`). */
const RANK = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,20})?(?:e[+-]?[0-9]{1,3})?$/;
const SMALL_POSITIVE = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 32767;

export function queryFingerprint(
  query: SearchQuery,
  editionId: string,
  book: string | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify([query.mode, editionId, book ?? null, query.tokens, query.separators]))
    .digest('base64url')
    .slice(0, 22);
}

export function encodeCursor(fingerprint: string, position: CursorPosition): string {
  const { rank, sequence, chapter, verse } = position;
  return Buffer.from(
    JSON.stringify([VERSION, fingerprint, rank, sequence, chapter, verse]),
  ).toString('base64url');
}

/** The position, or null for anything that is not a cursor this query issued. */
export function decodeCursor(cursor: string, fingerprint: string): CursorPosition | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [version, print, rank, sequence, chapter, verse] = value as unknown[];
  if (version !== VERSION || print !== fingerprint) return null;
  if (typeof rank !== 'string' || !RANK.test(rank)) return null;
  if (!SMALL_POSITIVE(sequence) || !SMALL_POSITIVE(chapter) || !SMALL_POSITIVE(verse)) {
    return null;
  }
  return { rank, sequence, chapter, verse };
}
