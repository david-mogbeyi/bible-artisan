import type { ThreadFilter, ThreadOrder } from '@bible-artisan/contracts';

/**
 * Keyset cursor for thread pages (BIB-32; PRD section 24: "Cursor encodes last sequence, filter,
 * and order; new events do not cause repeated or skipped prior pages"). Sequences are per study
 * and append-only, so seeking past the previous page's last sequence is stable while new events
 * arrive. The cursor carries no private content (a sequence, the listing's filters and an
 * optional branch id), and the query is always scoped by the session's owner and the path's
 * study, so a forged cursor can only move within the caller's own thread. It is still bound to
 * its listing: a cursor issued for other filters is refused.
 */
export interface ThreadListing {
  filter: ThreadFilter;
  order: ThreadOrder;
  branchId: string | null;
  includeInternal: boolean;
}

const VERSION = 1;
const SEQUENCE = /^[1-9][0-9]{0,18}$/;

export function encodeThreadCursor(listing: ThreadListing, sequence: string): string {
  const value = [
    VERSION,
    sequence,
    listing.filter,
    listing.order,
    listing.branchId,
    listing.includeInternal ? 1 : 0,
  ];
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** The last sequence of the previous page, or null for anything this listing did not issue. */
export function decodeThreadCursor(cursor: string, listing: ThreadListing): string | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [version, sequence, filter, order, branchId, internal] = value as unknown[];
  if (version !== VERSION || typeof sequence !== 'string' || !SEQUENCE.test(sequence)) return null;
  if (filter !== listing.filter || order !== listing.order) return null;
  if (branchId !== listing.branchId || internal !== (listing.includeInternal ? 1 : 0)) return null;
  return sequence;
}
