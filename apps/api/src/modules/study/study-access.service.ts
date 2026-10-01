import { Injectable } from '@nestjs/common';
import { type FindOptions, Transaction } from 'sequelize';
import { NotFoundError } from '../../common/errors/domain-errors';
import { isResourceId } from '../../common/validation/resource-id';
import { StudyNode } from '../../database/models/study-node.model';
import { Study } from '../../database/models/study.model';

export interface StudyAccessOptions {
  /** Run the lookup inside this transaction (required with `lock`). */
  transaction?: Transaction;
  /** `SELECT ... FOR UPDATE`, for a write that must hold the row until commit. */
  lock?: boolean;
}

/**
 * The one way to load a private study, or a child of it, for the signed-in owner (NFR-SEC-001,
 * PRD §29: "IDs do not grant access. Query children through owner/study constraints").
 *
 * - `ownerId` must come from the session (`@CurrentUserId()`), never from the request.
 * - Each lookup is a single query whose WHERE includes `owner_id`, so "absent" and "belongs to
 *   someone else" take the same path and throw the same `NotFoundError` (identical 404 envelope).
 * - IDs that are not UUIDs are answered the same way here too, so a caller that forgot
 *   `ParseResourceIdPipe` still fails closed (404, not a PostgreSQL cast error).
 *
 * Children follow `requireOwnedNode`'s pattern: filter by the child's own `id`, `study_id`, and
 * `owner_id`. The composite FK `(owner_id, study_id) -> study(owner_id, id)` guarantees a child's
 * owner is its study's owner, so this needs no join and never compares owners in application code.
 *
 * Lifecycle (archived/trashed) is not filtered here; the tickets that own those rules (BIB-22)
 * decide what each route allows.
 */
@Injectable()
export class StudyAccessService {
  async requireOwnedStudy(
    ownerId: string,
    studyId: string,
    options: StudyAccessOptions = {},
  ): Promise<Study> {
    if (!isResourceId(studyId)) throw new NotFoundError();
    const study = await Study.findOne({
      where: { id: studyId, ownerId },
      ...queryOptions(options),
    });
    if (!study) throw new NotFoundError();
    return study;
  }

  /** A live (not soft-deleted) node of `studyId`, owned by `ownerId`. */
  async requireOwnedNode(
    ownerId: string,
    studyId: string,
    nodeId: string,
    options: StudyAccessOptions = {},
  ): Promise<StudyNode> {
    if (!isResourceId(studyId) || !isResourceId(nodeId)) throw new NotFoundError();
    const node = await StudyNode.findOne({
      where: { id: nodeId, studyId, ownerId, deletedAt: null },
      ...queryOptions(options),
    });
    if (!node) throw new NotFoundError();
    return node;
  }
}

function queryOptions({
  transaction,
  lock,
}: StudyAccessOptions): Pick<FindOptions, 'transaction' | 'lock'> {
  // A row lock outside a transaction is released immediately, so it would protect nothing.
  if (lock && !transaction) throw new Error('StudyAccessService: lock requires a transaction');
  return {
    ...(transaction ? { transaction } : {}),
    ...(lock ? { lock: Transaction.LOCK.UPDATE } : {}),
  };
}
