import { z } from 'zod';

/**
 * Shared mutation conventions (PRD §24, §27). Every mutation endpoint takes the entity's
 * `expectedRevision` in its JSON body and accepts an optional `Idempotency-Key` header.
 */

/** Request header naming the client's operation key. A UUID the client reuses on every retry. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Response header set to `true` when the body is a replay of an earlier committed response. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Revisions are PostgreSQL `integer` columns starting at 1. */
export const REVISION_MAX = 2_147_483_647;

export const expectedRevisionSchema = z.number().int().min(1).max(REVISION_MAX);

/** Any-version UUID, case-insensitive (the server stores it lower-cased). */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * A per-study event sequence. PostgreSQL `bigint`, so it crosses the wire as a decimal string:
 * a JSON number would silently lose precision past 2^53.
 */
export const eventSequenceSchema = z.string().regex(/^[1-9][0-9]*$/);
