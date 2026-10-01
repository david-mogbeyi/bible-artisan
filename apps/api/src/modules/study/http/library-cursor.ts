import { createHash } from 'node:crypto';
import type { LibraryState, StudySort } from '@bible-artisan/contracts';
import { isResourceId } from '../../../common/validation/resource-id';

/**
 * Opaque keyset cursor for library pages (BIB-21). It holds the position of the last study on
 * the page: its group (pinned or not), its sort timestamp for `recent`/`created` (microsecond
 * UTC text, exactly as PostgreSQL stores it, so the next page starts precisely after it), and its
 * id. It never carries a title: `title` pages resolve the anchor's title by an owner-scoped id
 * lookup, so no private text travels in the URL.
 *
 * The fingerprint binds a cursor to the user and to the exact listing (state, sort, tag, search
 * words). It is a truncated SHA-256 salted with the owner's id, so the search words cannot be
 * recovered from it by guessing without that id, and a cursor replayed by another user, or with
 * other filters, is refused.
 */
export interface LibraryPosition {
  /** True for the pinned group, which comes first. */
  pinned: boolean;
  /** `recent`/`created`: the timestamp as `YYYY-MM-DDTHH:MM:SS.ffffffZ`; `title`: null. */
  key: string | null;
  id: string;
}

export interface LibraryListing {
  ownerId: string;
  state: LibraryState;
  sort: StudySort;
  tag: string | null;
  tokens: string[];
}

const VERSION = 1;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;

export function listingFingerprint(listing: LibraryListing): string {
  const { ownerId, state, sort, tag, tokens } = listing;
  return createHash('sha256')
    .update(JSON.stringify([ownerId, state, sort, tag, tokens]))
    .digest('base64url')
    .slice(0, 22);
}

export function encodeLibraryCursor(fingerprint: string, position: LibraryPosition): string {
  return Buffer.from(
    JSON.stringify([VERSION, fingerprint, position.pinned ? 1 : 0, position.key, position.id]),
  ).toString('base64url');
}

/** The position, or null for anything that is not a cursor this listing issued. */
export function decodeLibraryCursor(
  cursor: string,
  fingerprint: string,
  sort: StudySort,
): LibraryPosition | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [version, print, pinned, key, id] = value as unknown[];
  if (version !== VERSION || print !== fingerprint) return null;
  if (pinned !== 0 && pinned !== 1) return null;
  if (typeof id !== 'string' || !isResourceId(id)) return null;
  if (sort === 'title' ? key !== null : typeof key !== 'string' || !TIMESTAMP.test(key)) {
    return null;
  }
  return { pinned: pinned === 1, key: key as string | null, id: id.toLowerCase() };
}
