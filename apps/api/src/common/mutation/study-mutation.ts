import {
  type Attributes,
  type CreationAttributes,
  literal,
  type ModelStatic,
  type Transaction,
  type WhereAttributeHash,
} from 'sequelize';
import type { Model } from 'sequelize-typescript';
import { Study } from '../../database/models/study.model';
import type { StudyLock } from '../../modules/study/study-revision.service';
import type {
  AppendedEvent,
  AppendEventInput,
  ThreadService,
} from '../../modules/thread/thread.service';
import { NotFoundError, RevisionConflictError } from '../errors/domain-errors';
import { isResourceId } from '../validation/resource-id';

/** A row with an owner and an integer `revision` (study, study_node, and later revisioned tables). */
interface Revisioned {
  ownerId: string;
  revision: number;
}

export interface RevisionedUpdate<M extends Model & Revisioned> {
  /** The row's ID. For `Study` it must be the mutation's own `studyId`. */
  id: string;
  /** From the request body, via `requireExpectedRevision`. */
  expectedRevision: number;
  /** Columns to change (may be `{}`). `revision` is bumped here; scoping columns are fixed. */
  values: Partial<Omit<Attributes<M>, 'id' | 'revision' | 'ownerId' | 'studyId'>>;
  /** Extra filters, e.g. `{ deletedAt: null }` for rows whose soft-deleted state is not editable. */
  where?: WhereAttributeHash<Attributes<M>>;
}

/** Study columns the creating `work` may still set: never identity, owner, or counters. */
export type CreatedStudyValues = Partial<
  Pick<Attributes<Study>, 'originalQuestionNodeId' | 'mainQuestionNodeId'>
>;

/**
 * What a mutation's `work` receives from `MutationService.execute` (or `.create`): the study is
 * already locked (lock order receipt → study → children is fixed before `work` starts), and every
 * query inside `work` joins the mutation transaction automatically
 * (database/transaction-context.ts).
 *
 * `work` must call `appendEvent` at least once, and (except when creating the study, where there
 * is no earlier revision to compare against) `updateWithExpectedRevision` at least once, or the
 * pipeline throws and rolls everything back, unless it declares `unchanged()` (BIB-27) before
 * writing anything.
 */
export class StudyMutation {
  private revisionChecks = 0;
  private childWrites = 0;
  private declaredUnchanged = false;
  private finished = false;

  /** @internal Created by `MutationService.execute` and `MutationService.create`. */
  constructor(
    private readonly lock: StudyLock,
    private readonly thread: ThreadService,
    /** True when this mutation created the study (`MutationService.create`). */
    readonly creating = false,
  ) {}

  get transaction(): Transaction {
    return this.lock.transaction;
  }

  /** From the session. */
  get ownerId(): string {
    return this.lock.ownerId;
  }

  get studyId(): string {
    return this.lock.studyId;
  }

  /** The study's `archived_at` as locked, before this mutation's work (BIB-22). */
  get lockedArchivedAt(): Date | null {
    return this.lock.archivedAt;
  }

  /** The study `content_revision` this mutation commits (already bumped when declared). */
  get contentRevision(): number {
    return this.lock.contentRevision;
  }

  /**
   * Optimistic-concurrency update (PRD §24) of the study itself or one of its child rows, as one
   * conditional statement: `UPDATE … SET <values>, revision = revision + 1 WHERE id = :id AND
   * owner_id = :session [AND study_id = :study] [AND <where>] AND revision = :expected RETURNING *`.
   * Owner and study scoping are added here from the lock, never taken from the caller
   * (NFR-SEC-001). Concurrent writers already queue on the study row lock, so the check cannot
   * race. Zero rows → re-read: absent → 404, present → 409 with `currentRevision`.
   */
  async updateWithExpectedRevision<M extends Model & Revisioned>(
    model: ModelStatic<M>,
    { id, expectedRevision, values, where = {} }: RevisionedUpdate<M>,
  ): Promise<M> {
    this.assertWritable();
    if (!isResourceId(id)) throw new NotFoundError();
    const scope = this.scopeFor(model, id);
    const filter = { ...where, ...scope } as WhereAttributeHash<Attributes<M>>;
    const [, rows] = await model.update(
      { ...values, revision: literal('revision + 1') },
      {
        where: { ...filter, revision: expectedRevision } as WhereAttributeHash<Attributes<M>>,
        transaction: this.transaction,
        returning: true,
      },
    );
    const updated = rows[0];
    if (!updated) {
      const current = await model.findOne({
        where: filter,
        transaction: this.transaction,
        attributes: ['revision'],
      });
      if (!current) throw new NotFoundError();
      throw new RevisionConflictError(current.revision);
    }
    this.revisionChecks += 1;
    return updated;
  }

  /**
   * Inserts a row of a study-scoped child table (one with `study_id` and `owner_id`) for this
   * study. Owner and study come from the lock, never from the caller, and the table's composite
   * FK to `study (owner_id, id)` backs that up in the database.
   */
  async createChild<M extends Model>(
    model: ModelStatic<M>,
    values: Omit<CreationAttributes<M>, 'studyId' | 'ownerId'>,
  ): Promise<M> {
    this.assertWritable();
    const attributes = model.getAttributes();
    if (!('studyId' in attributes) || !('ownerId' in attributes)) {
      throw new Error('StudyMutation: model is not a study-scoped child');
    }
    // TypeScript cannot prove `Omit<T, K> & Pick<T, K>` is `T` for a generic T; the attribute
    // check above is what guarantees both keys exist on this model.
    const row = { ...values, studyId: this.studyId, ownerId: this.ownerId };
    this.childWrites += 1;
    return model.create(row as unknown as CreationAttributes<M>, {
      transaction: this.transaction,
    });
  }

  /**
   * Sets root pointers on the study this mutation is creating (BIB-19), in the creating
   * transaction. Not a revisioned edit: the study is still at revision 1, which no one has seen.
   * Refused for an existing study, whose changes go through `updateWithExpectedRevision`.
   */
  async updateCreatedStudy(values: CreatedStudyValues): Promise<void> {
    this.assertWritable();
    if (!this.creating) {
      throw new Error('StudyMutation: updateCreatedStudy is only for the study being created');
    }
    const [count] = await Study.update(values, {
      where: { id: this.studyId, ownerId: this.ownerId },
      transaction: this.transaction,
    });
    if (count !== 1) throw new Error('StudyMutation: the created study row vanished');
  }

  /**
   * Marks this mutation as a content change (`content_revision + 1` at commit, once however often
   * called), for work that only knows under the lock whether it changed content (BIB-20: a study
   * edit bumps it for a new title, description or main question, not for a pin or tag change).
   * Declare `bumpsContentRevision: true` on the spec instead when every run changes content.
   */
  bumpContentRevision(): void {
    this.assertWritable();
    this.lock.bumpContentRevision();
  }

  /** Appends a Study Thread event for this study in this transaction; returns its sequence. */
  async appendEvent(input: AppendEventInput): Promise<AppendedEvent> {
    this.assertWritable();
    return this.thread.appendEvent(this.lock, input);
  }

  /**
   * Declares that this mutation found nothing to change (BIB-27: connecting two nodes that already
   * have that relationship answers 200 `existing`). The pipeline then requires no revision check
   * and no event, writes no counters (study `revision`, `content_revision`, `last_event_sequence`
   * and `last_activity_at` stay as they are), and still stores the response on the
   * Idempotency-Key receipt, so a retry replays it exactly. The lifecycle guard has already run.
   *
   * Allowed only before any write through this context (a revision check, a child insert, an
   * event, a content bump, or a spec declaring `bumpsContentRevision: true`), and no write through
   * it is allowed afterwards: either throws, a programming error that rolls everything back
   * (500). Writes that bypass this context cannot be tracked, so an unchanged work must not make
   * any.
   */
  unchanged(): void {
    this.assertOpen();
    if (this.creating) throw new Error('StudyMutation: creating a study always changes it');
    if (this.revisionChecks > 0 || this.childWrites > 0 || this.lock.countersChanged) {
      throw new Error('StudyMutation: unchanged() after this mutation already wrote');
    }
    this.declaredUnchanged = true;
  }

  /** @internal Checked by `MutationService` once `work` resolves. */
  get isUnchanged(): boolean {
    return this.declaredUnchanged;
  }

  /** @internal Checked by `MutationService` once `work` resolves. */
  get revisionChecked(): boolean {
    return this.revisionChecks > 0;
  }

  /** @internal Checked by `MutationService` once `work` resolves. */
  get eventsAppended(): number {
    return this.lock.eventsAppended;
  }

  /** @internal Called by `MutationService` when `work` settles. */
  finish(): void {
    this.finished = true;
  }

  private assertOpen(): void {
    if (this.finished) throw new Error('StudyMutation used after its work finished');
    this.lock.assertHeld();
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.declaredUnchanged) {
      throw new Error('StudyMutation: a write after unchanged() was declared');
    }
  }

  private scopeFor(model: ModelStatic<Model>, id: string): Record<string, string> {
    if (model === Study) {
      if (id !== this.studyId) {
        throw new Error('StudyMutation: a mutation may only revision-check its own study');
      }
      return { id, ownerId: this.ownerId };
    }
    if ('studyId' in model.getAttributes()) {
      return { id, studyId: this.studyId, ownerId: this.ownerId };
    }
    throw new Error('StudyMutation: model is neither the study nor a study-scoped child');
  }
}
