import { Injectable } from '@nestjs/common';
import { type FindOptions, literal, Op, Transaction } from 'sequelize';
import { NotFoundError } from '../../common/errors/domain-errors';
import { isResourceId } from '../../common/validation/resource-id';
import { StudyNode } from '../../database/models/study-node.model';
import { Study } from '../../database/models/study.model';
import { withinRecoveryWindow, withinRecoveryWindowSql } from './study-lifecycle';

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
 * `owner_id`, plus its study's recovery window, in the same statement. The composite FK
 * `(owner_id, study_id) -> study(owner_id, id)` guarantees a child's owner is its study's owner,
 * so owners are never compared in application code.
 *
 * Lifecycle (BIB-22): archived and trashed studies stay readable by their owner (the mutation
 * pipeline, not this service, refuses writes to them), but a study trashed 30 or more days ago is
 * past its recovery window and is the same 404 as an absent one, even before the purge removes it.
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
      where: { id: studyId, ownerId, ...withinRecoveryWindow() },
      ...queryOptions(options),
    });
    if (!study) throw new NotFoundError();
    return study;
  }

  /**
   * A live (not soft-deleted) node of `studyId`, owned by `ownerId`, in ONE statement: the node's
   * own `id`, `study_id` and `owner_id`, and its study (same owner, by the composite FK) inside
   * its recovery window (`withinRecoveryWindowSql`). So a node of an absent, foreign or expired
   * study is the same 404 as an absent node (BIB-22). With `lock`, only the node row is locked.
   */
  async requireOwnedNode(
    ownerId: string,
    studyId: string,
    nodeId: string,
    options: StudyAccessOptions = {},
  ): Promise<StudyNode> {
    if (!isResourceId(studyId) || !isResourceId(nodeId)) throw new NotFoundError();
    const node = await StudyNode.findOne({
      where: {
        id: nodeId,
        studyId,
        ownerId,
        deletedAt: null,
        [Op.and]: [
          literal(`EXISTS (SELECT 1 FROM study s
                            WHERE s.owner_id = "StudyNode".owner_id
                              AND s.id = "StudyNode".study_id
                              AND ${withinRecoveryWindowSql('s')})`),
        ],
      },
      ...queryOptions(options),
    });
    if (!node) throw new NotFoundError();
    return node;
  }

  /**
   * Nodes of the owner's study `studyId` with these ids, soft-deleted ones included (BIB-23: a
   * note keeps its target after the node is deleted, for orphaned-note review). Callers resolve
   * the study first (`requireOwnedStudy`, or the mutation's lock); the query is still scoped by
   * the node's own `study_id` and `owner_id`, so another study's or owner's id matches nothing.
   * Ids that are not UUIDs are skipped.
   */
  async ownedNodesIncludingDeleted(
    ownerId: string,
    studyId: string,
    nodeIds: readonly string[],
  ): Promise<StudyNode[]> {
    const ids = [...new Set(nodeIds)].filter(isResourceId);
    if (ids.length === 0 || !isResourceId(studyId)) return [];
    return StudyNode.findAll({ where: { id: ids, studyId, ownerId } });
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
