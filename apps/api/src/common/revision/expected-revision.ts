import { expectedRevisionSchema } from '@bible-artisan/contracts';
import {
  type Attributes,
  literal,
  type ModelStatic,
  type Transaction,
  type WhereAttributeHash,
} from 'sequelize';
import type { Model } from 'sequelize-typescript';
import { z } from 'zod';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../errors/domain-errors';
import { parseBody } from '../validation/parse-body';

const expectedRevisionBody = z.object({ expectedRevision: expectedRevisionSchema });

/**
 * The `expectedRevision` a mutation body must carry (PRD §24, §27). Call it before parsing the
 * rest of the body so a missing revision is always 428, whatever else is wrong:
 * - body not a JSON object → 400 `VALIDATION`;
 * - `expectedRevision` absent or null → 428 `REVISION_MISSING`;
 * - present but not an integer in 1..2^31-1 → 400 `VALIDATION` on `expectedRevision`.
 */
export function requireExpectedRevision(body: unknown): number {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Invalid request', { _: ['Expected a JSON object'] });
  }
  const value = (body as Record<string, unknown>).expectedRevision;
  if (value === undefined || value === null) throw new RevisionMissingError();
  return parseBody(expectedRevisionBody, { expectedRevision: value }).expectedRevision;
}

/** A row with an owner and an integer `revision` (study, study_node, and later revisioned tables). */
interface Revisioned {
  ownerId: string;
  revision: number;
}

export interface RevisionedUpdate<M extends Model & Revisioned> {
  /**
   * Identifies the row. Must include `ownerId` from the session (NFR-SEC-001), plus the row's
   * `id` and, for children, `studyId` (and `deletedAt: null` where soft-deleted rows are not
   * editable). IDs must already be validated as UUIDs (`ParseResourceIdPipe`).
   */
  where: WhereAttributeHash<Attributes<M>> & { ownerId: string };
  expectedRevision: number;
  /** Columns to change. `revision` is bumped here and must not be passed. */
  values: Partial<Omit<Attributes<M>, 'revision' | 'ownerId'>>;
  transaction: Transaction;
}

/**
 * Optimistic-concurrency update (PRD §24): one conditional statement,
 * `UPDATE … SET <values>, revision = revision + 1 WHERE <where> AND revision = :expected
 * RETURNING *`. Check and bump are atomic: concurrent writers holding the same expected revision
 * queue on the row lock, and once the first commits, PostgreSQL re-evaluates the others' WHERE
 * against the new row, so they match nothing. No lost updates, no explicit lock.
 *
 * Zero rows → re-read in the same transaction: no row → 404 `NotFoundError`; row → 409
 * `RevisionConflictError` with its current revision. Returns the updated row (new revision).
 */
export async function updateWithExpectedRevision<M extends Model & Revisioned>(
  model: ModelStatic<M>,
  { where, expectedRevision, values, transaction }: RevisionedUpdate<M>,
): Promise<M> {
  const [, rows] = await model.update(
    { ...values, revision: literal('revision + 1') },
    { where: { ...where, revision: expectedRevision }, transaction, returning: true },
  );
  const updated = rows[0];
  if (updated) return updated;

  const current = await model.findOne({ where, transaction, attributes: ['revision'] });
  if (!current) throw new NotFoundError();
  throw new RevisionConflictError(current.revision);
}
