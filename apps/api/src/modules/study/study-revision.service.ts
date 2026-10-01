import { Injectable } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { NotFoundError } from '../../common/errors/domain-errors';
import { isResourceId } from '../../common/validation/resource-id';
import { Study } from '../../database/models/study.model';

/** The columns a new study is created with; owner and counters are never the caller's. */
export interface NewStudy {
  title: string;
  startingReferenceId: string | null;
}

/**
 * Proof that a transaction holds a study's row lock, plus the study's counters as this mutation
 * will commit them (PRD §23). Created only by `StudyRevisionService.lock`; `MutationService` owns
 * its lifecycle. Event sequences are allocated from it in memory: the row lock makes this
 * transaction the study's only writer until COMMIT, so `last + 1, last + 2, …` cannot collide,
 * and `StudyRevisionService.writeCounters` persists the final values in one UPDATE.
 */
export class StudyLock {
  private released = false;
  private eventSequence: bigint;
  private contentBumped = false;

  /** @internal Use `StudyRevisionService.lock`. */
  constructor(
    readonly transaction: Transaction,
    readonly ownerId: string,
    readonly studyId: string,
    /** `study.content_revision` when the lock was taken. */
    private readonly lockedContentRevision: number,
    /** `study.last_event_sequence` when the lock was taken. */
    readonly lockedEventSequence: bigint,
  ) {
    this.eventSequence = lockedEventSequence;
  }

  /** The next per-study event sequence, as a decimal string (bigint; never Number() it). */
  allocateEventSequence(): string {
    this.assertHeld();
    this.eventSequence += 1n;
    return this.eventSequence.toString();
  }

  /** Marks this mutation as a content change: `content_revision + 1` once, however often called. */
  bumpContentRevision(): void {
    this.assertHeld();
    this.contentBumped = true;
  }

  /** The content revision this mutation commits. */
  get contentRevision(): number {
    return this.lockedContentRevision + (this.contentBumped ? 1 : 0);
  }

  /** The last event sequence this mutation commits. */
  get lastEventSequence(): bigint {
    return this.eventSequence;
  }

  /** Events appended under this lock so far. */
  get eventsAppended(): number {
    return Number(this.eventSequence - this.lockedEventSequence);
  }

  /** True when a counter differs from the locked row, so `writeCounters` has something to write. */
  get countersChanged(): boolean {
    return this.contentBumped || this.eventSequence !== this.lockedEventSequence;
  }

  /** Throws once the mutation that took the lock has finished (or for a forged lock). */
  assertHeld(): void {
    // Sequelize sets `finished` ('commit' | 'rollback') on a transaction once it ends.
    const { finished } = this.transaction as Transaction & { finished?: string };
    if (this.released || finished !== undefined) {
      throw new Error('StudyLock used after its mutation finished');
    }
  }

  /** @internal Called by `MutationService` when the work ends. */
  release(): void {
    this.released = true;
  }
}

/**
 * The study row's lock and transactional counters (PRD §23). Study owns the `study` table, so the
 * mutation pipeline reaches these columns only through this service.
 *
 * Lock order (enforced by `MutationService`, which is the only caller): receipt claim → `lock()`
 * (`SELECT … FOR UPDATE` on the study row), or `create()` for a new study (the INSERT holds the
 * new row's lock) → the mutation's own rows (the study's revision or a
 * child's) → `writeCounters()` (same study row, already locked). Every study-scoped mutation takes
 * the study row first, so two mutations of one study can never hold a child row each and wait on
 * the other: they queue on the study row instead.
 */
@Injectable()
export class StudyRevisionService {
  /** Locks the owner's study row until the transaction ends. Absent or another owner's → 404. */
  async lock(transaction: Transaction, ownerId: string, studyId: string): Promise<StudyLock> {
    // A row lock outside a transaction is released at once, so it would protect nothing.
    if (!(transaction instanceof Transaction)) {
      throw new Error('StudyRevisionService.lock requires a transaction');
    }
    if (!isResourceId(studyId)) throw new NotFoundError();
    const study = await Study.findOne({
      where: { id: studyId, ownerId },
      attributes: ['contentRevision', 'lastEventSequence'],
      transaction,
      lock: Transaction.LOCK.UPDATE,
    });
    if (!study) throw new NotFoundError();
    return new StudyLock(
      transaction,
      ownerId,
      studyId,
      study.contentRevision,
      BigInt(study.lastEventSequence),
    );
  }

  /**
   * Inserts a new study for `ownerId` (from the session) and returns the lock on it (BIB-19). The
   * INSERT holds the new row's lock until the transaction ends, and the row is invisible to
   * everyone else until COMMIT, so the creating transaction is its only writer, exactly as after
   * `lock()`. The lock starts from the inserted counters: revision 1, content revision 1 (every
   * root created in this transaction shares it, PRD section 24) and event sequence 0.
   */
  async create(transaction: Transaction, ownerId: string, values: NewStudy): Promise<StudyLock> {
    if (!(transaction instanceof Transaction)) {
      throw new Error('StudyRevisionService.create requires a transaction');
    }
    const study = await Study.create({ ...values, ownerId }, { transaction });
    return new StudyLock(
      transaction,
      ownerId,
      study.id,
      study.contentRevision,
      BigInt(study.lastEventSequence),
    );
  }

  /**
   * Persists the lock's counters in ONE statement: `content_revision` (when the mutation bumped
   * it) and `last_event_sequence` (when it appended events). No-op when neither changed.
   */
  async writeCounters(lock: StudyLock): Promise<void> {
    lock.assertHeld();
    if (!lock.countersChanged) return;
    const [, rows] = await Study.update(
      {
        contentRevision: lock.contentRevision,
        lastEventSequence: lock.lastEventSequence.toString(),
      },
      {
        where: { id: lock.studyId, ownerId: lock.ownerId },
        transaction: lock.transaction,
        returning: ['id'],
        // silent: counters are not an edit of the study itself, so updated_at stays put.
        silent: true,
      },
    );
    if (rows.length !== 1) throw new Error('StudyRevisionService: locked study row vanished');
  }
}
