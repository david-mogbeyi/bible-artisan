import { Injectable } from '@nestjs/common';
import { literal, Transaction } from 'sequelize';
import { NotFoundError } from '../../common/errors/domain-errors';
import { isResourceId } from '../../common/validation/resource-id';
import { Study } from '../../database/models/study.model';

/**
 * The study row's transactional counters (PRD §23). Study owns the `study` table, so other modules
 * (Thread, Graph, Notes) bump these only through this service, inside their mutation transaction.
 *
 * Each method is one owner-scoped `UPDATE … RETURNING`, which takes the study row lock and holds
 * it until the caller's transaction ends. Lock order inside a mutation: receipt claim, then the
 * study row (these methods, or a study revision update), then child rows.
 */
@Injectable()
export class StudyRevisionService {
  /**
   * Allocates the study's next event sequence (1, 2, 3, …). Concurrent allocations on one study
   * queue on the row lock and receive consecutive values in commit order; a rolled-back
   * transaction undoes its increment, so committed sequences have no gaps. Returns a decimal
   * string (bigint). Absent or another owner's study → 404.
   */
  async nextEventSequence(
    transaction: Transaction,
    ownerId: string,
    studyId: string,
  ): Promise<string> {
    const study = await this.increment(transaction, ownerId, studyId, 'lastEventSequence');
    return study.lastEventSequence;
  }

  /**
   * Records that the study's content changed (`content_revision + 1`, PRD §23). Call it from
   * content mutations only; read/navigation events must not move it. Returns the new value.
   */
  async bumpContentRevision(
    transaction: Transaction,
    ownerId: string,
    studyId: string,
  ): Promise<number> {
    const study = await this.increment(transaction, ownerId, studyId, 'contentRevision');
    return study.contentRevision;
  }

  private async increment(
    transaction: Transaction,
    ownerId: string,
    studyId: string,
    attribute: 'lastEventSequence' | 'contentRevision',
  ): Promise<Study> {
    // A row lock outside a transaction is released at once, so the counter would protect nothing.
    if (!(transaction instanceof Transaction)) {
      throw new Error('StudyRevisionService requires a transaction');
    }
    if (!isResourceId(studyId)) throw new NotFoundError();
    const column = attribute === 'lastEventSequence' ? 'last_event_sequence' : 'content_revision';
    const [, rows] = await Study.update(
      { [attribute]: literal(`${column} + 1`) },
      // silent: counters are not an edit of the study itself, so updated_at stays put.
      { where: { id: studyId, ownerId }, transaction, returning: true, silent: true },
    );
    const study = rows[0];
    if (!study) throw new NotFoundError();
    return study;
  }
}
