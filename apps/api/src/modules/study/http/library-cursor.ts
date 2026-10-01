import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { LibraryState, StudySort } from '@bible-artisan/contracts';
import { isResourceId } from '../../../common/validation/resource-id';

/**
 * Opaque keyset cursor for library pages (BIB-21), sealed with AES-256-GCM.
 *
 * Wire format: base64url( version (1 byte) ‖ IV (12 random bytes) ‖ ciphertext ‖ tag (16) ),
 * with the version byte as additional authenticated data. The key is derived with HKDF-SHA256
 * from the server's CURSOR_SECRET (`cursorSecret` in config/env.ts) for this purpose only.
 *
 * The plaintext is the JSON array `[ownerId, fingerprint, pinned (0|1), key, id]`: the whole
 * position of the previous page's last study, as it was when that page was read:
 *
 * - its group (pinned or not);
 * - its sort value: for `recent`/`created` the timestamp as microsecond UTC text, exactly as
 *   PostgreSQL stores it; for `title` a snapshot of its `title_sort_key`. The next page seeks from
 *   this snapshot and never re-reads the anchor, so renaming, unpinning or deleting the anchor
 *   between pages never skips or repeats a study that did not change;
 * - its id (the tiebreak).
 *
 * Everything is inside the ciphertext, so the title snapshot and the search words (hashed into
 * the fingerprint) cannot be read, guessed against, or forged from the cursor without the server
 * secret. A cursor that fails authentication, belongs to another owner, or was issued for other
 * filters (state, sort, pin grouping, tag, words) decodes to null: the caller answers 400 with a
 * fixed message.
 */
export interface LibraryPosition {
  /** True for the pinned group. */
  pinned: boolean;
  /** `recent`/`created`: `YYYY-MM-DDTHH:MM:SS.ffffffZ`; `title`: the title sort key snapshot. */
  key: string;
  id: string;
}

export interface LibraryListing {
  ownerId: string;
  state: LibraryState;
  sort: StudySort;
  pinnedFirst: boolean;
  tag: string | null;
  tokens: string[];
}

const VERSION = 1;
const VERSION_BYTE = Buffer.from([VERSION]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;

/** The AES-256 key for library cursors, derived from the server secret for this use alone. */
export function libraryCursorKey(secret: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'bible-artisan/library-cursor/v1', 32),
  );
}

/**
 * Binds a cursor to the exact listing (everything but the owner, which the cursor carries on its
 * own, and `limit`, which may change between pages). Only ever stored inside the ciphertext.
 */
function listingFingerprint(listing: LibraryListing): string {
  const { state, sort, pinnedFirst, tag, tokens } = listing;
  return createHash('sha256')
    .update(JSON.stringify([state, sort, pinnedFirst, tag, tokens]))
    .digest('base64url');
}

export function encodeLibraryCursor(
  key: Buffer,
  listing: LibraryListing,
  position: LibraryPosition,
): string {
  const plaintext = JSON.stringify([
    listing.ownerId,
    listingFingerprint(listing),
    position.pinned ? 1 : 0,
    position.key,
    position.id,
  ]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(VERSION_BYTE);
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([VERSION_BYTE, iv, sealed, cipher.getAuthTag()]).toString('base64url');
}

/** The position, or null for anything that is not a cursor this server issued for this listing. */
export function decodeLibraryCursor(
  key: Buffer,
  cursor: string,
  listing: LibraryListing,
): LibraryPosition | null {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length < 1 + IV_BYTES + TAG_BYTES + 1 || bytes[0] !== VERSION) return null;
  let value: unknown;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(VERSION_BYTE);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(1 + IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]);
    value = JSON.parse(plaintext.toString('utf8'));
  } catch {
    // Wrong key, tampered bytes or tag, truncated: all the same refusal.
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [owner, print, pinned, sortKey, id] = value as unknown[];
  if (owner !== listing.ownerId || print !== listingFingerprint(listing)) return null;
  if (pinned !== 0 && pinned !== 1) return null;
  if (typeof id !== 'string' || !isResourceId(id) || typeof sortKey !== 'string') return null;
  if (listing.sort !== 'title' && !TIMESTAMP.test(sortKey)) return null;
  return { pinned: pinned === 1, key: sortKey, id: id.toLowerCase() };
}
