import {
  type Attributes,
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

/**
 * What a mutation's `work` receives from `MutationService.execute`: the study is already locked
 * (lock order receipt → study → children is fixed before `work` starts), and every query inside
 * `work` joins the mutation transaction automatically (database/transaction-context.ts).
 *
 * `work` must call `updateWithExpectedRevision` and `appendEvent` at least once each, or
 * `execute` throws and rolls everything back.
 */
export class StudyMutation {
  private revisionChecks = 0;
  private finished = false;

  /** @internal Created by `MutationService.execute`. */
  constructor(
    private readonly lock: StudyLock,
    private readonly thread: ThreadService,
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
    this.assertOpen();
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

  /** Appends a Study Thread event for this study in this transaction; returns its sequence. */
  async appendEvent(input: AppendEventInput): Promise<AppendedEvent> {
    this.assertOpen();
    return this.thread.appendEvent(this.lock, input);
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
