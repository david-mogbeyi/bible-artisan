import { Inject, Injectable } from '@nestjs/common';
import { STUDY_EVENT_LIMIT_REACHED } from '@bible-artisan/contracts';
import { fn, Op, QueryTypes, Transaction } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { MutationReceipt } from '../../database/models/mutation-receipt.model';
import { activeTransaction } from '../../database/transaction-context';
import {
  type NewStudy,
  type StudyLock,
  StudyRevisionService,
} from '../../modules/study/study-revision.service';
import {
  assertLifecycleAllows,
  type StudyLifecycleTransition,
} from '../../modules/study/study-lifecycle';
import { AccountStorageService } from '../../modules/study/account-storage.service';
import { SAFETY_LIMITS, type SafetyLimits } from '../../modules/study/safety-limits';
import { ThreadService } from '../../modules/thread/thread.service';
import { IdempotencyKeyReusedError, LimitReachedError } from '../errors/domain-errors';
import { requestFingerprint } from './fingerprint';
import type { MutationRequestInfo } from './mutation-request';
import { StudyMutation } from './study-mutation';

/** PRD §23: receipts are kept seven days, the supported lifetime of a client's offline queue. */
export const RECEIPT_TTL_DAYS = 7;

/** What a mutation's work returns: a 2xx status and a JSON object body. */
export interface MutationResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * What `execute` resolves to. Return it from the controller as is: `MutationResultInterceptor`
 * (registered globally by `MutationModule`) applies `status`, `Idempotent-Replayed: true` for a
 * replay, and `Cache-Control: no-store`, and sends `body`. Serializing it any other way throws, so
 * a handler that unwraps it by hand fails loudly instead of losing the replay status/header.
 */
export class MutationResult implements MutationResponse {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    /** True when this is a stored response replayed for a retry; the work did not run. */
    readonly replayed: boolean,
  ) {}

  toJSON(): never {
    throw new Error('MutationResult must be returned from a controller, not serialized');
  }
}

/** One study-scoped mutation, as declared to `MutationService.execute`. */
export interface StudyMutationSpec {
  /** The study being mutated (route param through `ParseResourceIdPipe`). Locked before `work`. */
  studyId: string;
  /**
   * Content mutations (graph, notes, conclusions, study title, …) move `content_revision` by
   * exactly one (PRD §23). Navigation and view-state mutations pass `false`.
   */
  bumpsContentRevision: boolean;
  /**
   * Only for the lifecycle routes (BIB-22): the lifecycle change this mutation makes. Every other
   * mutation leaves it out and so needs an active study: the pipeline refuses an archived study
   * with 422 STUDY_ARCHIVED and a trashed one with 422 STUDY_TRASHED before `work` runs. A
   * transition is allowed only from its starting states (`STUDY_LIFECYCLE_TRANSITIONS`).
   */
  lifecycleTransition?: StudyLifecycleTransition;
  /**
   * Navigation and reading activity (BIB-55, `POST /studies/:id/activity`): a deliberate visit is
   * recorded without an `expectedRevision`, so it never conflicts with (or 409s) edits in other
   * tabs. The work needs no revision check, must append at least one event, and must not bump
   * the content revision (`bumpsContentRevision: false`). Revision and content revision stay put.
   */
  navigation?: boolean;
  /**
   * Removals only (BIB-52): deleting a node or relationship, trashing a note, removing a
   * highlight. They stay available at a safety cap (PRD section 28: "At safety cap permit
   * review/export/delete while blocking additions"). Every other mutation, except a lifecycle
   * transition (archive, trash, restore), is refused at the study's event cap (422
   * STUDY_EVENT_LIMIT_REACHED) and at the account's storage cap (422 STORAGE_LIMIT_REACHED).
   */
  allowedAtCap?: boolean;
  /**
   * The domain work. Must revision-check at least one row with `m.updateWithExpectedRevision`
   * and append at least one event with `m.appendEvent`, or declare `m.unchanged()` before writing
   * anything (then neither, and no counters). Every query joins the mutation transaction
   * automatically. Call no external provider.
   */
  work: (m: StudyMutation) => Promise<MutationResponse>;
}

/** A study creation, as declared to `MutationService.create` (BIB-19). */
export interface StudyCreationSpec {
  /** The new study's columns. The owner is `create`'s `ownerId`; counters are the pipeline's. */
  study: NewStudy;
  /**
   * The domain work on the new study: create its children with `m.createChild`, set its root
   * pointers with `m.updateCreatedStudy`, and append at least one event. Same transaction rules
   * as `StudyMutationSpec.work`.
   */
  work: (m: StudyMutation) => Promise<MutationResponse>;
}

/**
 * Runs one study mutation exactly once per (owner, Idempotency-Key) (PRD §23, §24, §27;
 * FR-STUDY-002). The only way domain code mutates study data.
 *
 * Everything happens in ONE READ COMMITTED transaction (set explicitly, whatever the database
 * default), and `execute` resolves only after COMMIT returns, so a caller can never acknowledge
 * ("Saved") work that is not durable (NFR-REL-001). Steps, which are also the lock order:
 *
 * 1. Claim the receipt (only with an Idempotency-Key): INSERT (owner_id, key) … ON CONFLICT DO
 *    UPDATE only when the existing row has expired. A concurrent duplicate waits on the first
 *    request's uncommitted unique-index entry: when it commits, the claim fails and we replay its
 *    response (same fingerprint) or 422 `IdempotencyKeyReusedError` (different one); when it rolls
 *    back, the claim succeeds and we run. No duplicate execution, no "in progress" state.
 * 2. Lock the study row (`SELECT … FOR UPDATE`, owner-scoped: absent/foreign, or trashed past its
 *    recovery window → 404). Every mutation of one study queues here before touching any child
 *    row, so mutations of one study cannot deadlock on each other's child rows. Then the
 *    lifecycle guard: an archived or trashed study is 422 unless the spec names a lifecycle
 *    transition that starts from its state (BIB-22).
 * 3. Run `work` with a `StudyMutation`. It must make ≥1 revision check and append ≥1 event;
 *    otherwise `execute` throws (a programming error, 500) and rolls everything back. The one
 *    exception is a work that declares `m.unchanged()` before writing anything (BIB-27): it
 *    writes no event and no counters, and step 4 still stores its response on the receipt.
 * 4. Write the study counters (content_revision, last_event_sequence) in one UPDATE, store the
 *    response on the receipt, COMMIT.
 *
 * Any error from the work (404, 409, 422, …) or COMMIT rolls back the receipt with the domain
 * writes and events, so failures are never cached and a retry with the same key re-runs.
 * Receipts are keyed by owner; `ownerId` must come from the session.
 *
 * `create` is the same pipeline for a study that does not exist yet (see its comment).
 */
@Injectable()
export class MutationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly studyRevisions: StudyRevisionService,
    private readonly thread: ThreadService,
    private readonly storage: AccountStorageService,
    @Inject(SAFETY_LIMITS) private readonly limits: SafetyLimits,
  ) {}

  async execute(
    ownerId: string,
    request: MutationRequestInfo,
    spec: StudyMutationSpec,
  ): Promise<MutationResult> {
    const capped = spec.lifecycleTransition === undefined && spec.allowedAtCap !== true;
    return this.transact(ownerId, request, async (transaction) => {
      const lock = await this.studyRevisions.lock(transaction, ownerId, spec.studyId);
      // The lifecycle guard (BIB-22), once for every study mutation: under the lock, before any
      // work, so a refusal writes nothing and rolls the receipt back.
      assertLifecycleAllows(lock.lifecycle, spec.lifecycleTransition);
      // The event cap (BIB-52; NFR-SCALE-002): the study's history is never dropped, so at the cap
      // only reads, exports, lifecycle changes and removals go on. One mutation appends a handful
      // of events, so the cap can be passed by at most that many.
      if (capped && lock.lockedEventSequence >= BigInt(this.limits.maxEventsPerStudy)) {
        throw new LimitReachedError(STUDY_EVENT_LIMIT_REACHED);
      }
      // The account's storage cap (BIB-52), after the owner-scoped lock (an absent or foreign
      // study stays a plain 404) and the receipt claim (a retry of a committed request replays).
      // Cached per owner, so it measures at most once per window.
      if (capped) await this.storage.assertRoom(ownerId);
      if (spec.navigation && spec.bumpsContentRevision) {
        throw new Error('MutationService: a navigation mutation cannot bump the content revision');
      }
      if (spec.bumpsContentRevision) lock.bumpContentRevision();
      return this.run(
        lock,
        spec.work,
        false,
        request.correlationId ?? null,
        spec.navigation,
        request.tabInstanceId ?? null,
      );
    });
  }

  /**
   * Creates a study (BIB-19, FR-STUDY-001/002): the creation entry point of the same pipeline,
   * with the same guarantees as `execute`. The steps differ only where there is no row yet:
   *
   * 1. Claim the receipt exactly as `execute` does (same fingerprint, replay, 422 on reuse), so a
   *    retried or concurrent duplicate create replays the first one's study instead of making a
   *    second.
   * 2. INSERT the study for `ownerId` (from the session) in place of locking an existing row.
   *    The insert holds the new row's lock, so lock order stays receipt → study → children.
   * 3. Run `work` with a `StudyMutation` in creation mode: no revision check is required (there
   *    is no earlier revision for a client to have seen, so no `expectedRevision` and never 428),
   *    but at least one event still is. Children go in through `m.createChild`.
   * 4. Write the counters in one UPDATE, store the response on the receipt, COMMIT.
   *
   * The study starts at revision 1 and content revision 1, which every root created in this
   * transaction shares (PRD section 24); its first event is sequence 1.
   */
  async create(
    ownerId: string,
    request: MutationRequestInfo,
    spec: StudyCreationSpec,
  ): Promise<MutationResult> {
    return this.transact(ownerId, request, async (transaction) => {
      // A new study adds to the account: refused at the storage cap (BIB-52).
      await this.storage.assertRoom(ownerId);
      const lock = await this.studyRevisions.create(transaction, ownerId, spec.study);
      return this.run(
        lock,
        spec.work,
        true,
        request.correlationId ?? null,
        false,
        request.tabInstanceId ?? null,
      );
    });
  }

  /**
   * A mutation of the owner's own account, not of a study (BIB-40: `PUT /me/ai-consent`). Same
   * transaction, receipt claim, fingerprint, replay, 422 on key reuse and COMMIT-before-reply as
   * `execute`; there is no study lock, no StudyEvent (no study changed) and no study counter. The
   * work locks and revision-checks its own owner-scoped row (428 / 409 as everywhere) and must not
   * touch any study's data: anything study-scoped goes through `execute`. `ownerId` must come from
   * the session.
   */
  async executeForOwner(
    ownerId: string,
    request: MutationRequestInfo,
    work: (transaction: Transaction) => Promise<MutationResponse>,
  ): Promise<MutationResult> {
    return this.transact(ownerId, request, async (transaction) =>
      normalized(await work(transaction)),
    );
  }

  /**
   * For a route that does expensive read-only work before its mutation (exports render the whole
   * study before storing the file): the committed response a retry with this Idempotency-Key
   * replays, so the route can return it without redoing that work or hitting its rate limit.
   * Null when there is nothing to replay yet (no key, no live receipt, or one still in flight).
   * Same rule as `execute`: a live receipt for a different request is 422. This only reads; the
   * route must still store its result through `executeForOwner` with the same request, whose
   * claim replays a concurrent duplicate that committed in between.
   */
  async committedReplay(
    ownerId: string,
    request: MutationRequestInfo,
  ): Promise<MutationResult | null> {
    const { idempotencyKey } = request;
    if (idempotencyKey === null) return null;
    const receipt = await MutationReceipt.findOne({
      where: { ownerId, idempotencyKey, expiresAt: { [Op.gt]: fn('now') } },
    });
    if (!receipt || receipt.responseStatus === null || receipt.responseBody === null) return null;
    if (receipt.requestHash !== requestFingerprint(request)) throw new IdempotencyKeyReusedError();
    return new MutationResult(receipt.responseStatus, receipt.responseBody, true);
  }

  /**
   * Step 1 and the end of every mutation: one READ COMMITTED transaction, the receipt claimed
   * first (or the committed response replayed), and the response stored on the receipt before
   * COMMIT. `run` does everything in between.
   */
  private async transact(
    ownerId: string,
    request: MutationRequestInfo,
    run: (transaction: Transaction) => Promise<MutationResponse>,
  ): Promise<MutationResult> {
    // A nested call would open a second transaction on another connection: not atomic with
    // the outer one, and able to wait on locks the outer one holds.
    if (activeTransaction() !== undefined) {
      throw new Error('MutationService cannot run inside another transaction');
    }
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        const { idempotencyKey } = request;
        if (idempotencyKey !== null) {
          const requestHash = requestFingerprint(request);
          const claimed = await this.claim(
            transaction,
            ownerId,
            idempotencyKey,
            request,
            requestHash,
          );
          if (!claimed) return this.replay(transaction, ownerId, idempotencyKey, requestHash);
        }

        const response = await run(transaction);

        if (idempotencyKey !== null) {
          await MutationReceipt.update(
            { responseStatus: response.status, responseBody: response.body },
            { where: { ownerId, idempotencyKey }, transaction },
          );
        }
        return new MutationResult(response.status, response.body, false);
      },
    );
  }

  /** Steps 3–4 on a held study lock: work, invariant checks, counters. */
  private async run(
    lock: StudyLock,
    work: StudyMutationSpec['work'],
    creating: boolean,
    correlationId: string | null,
    navigation = false,
    tabInstanceId: string | null = null,
  ): Promise<MutationResponse> {
    const mutation = new StudyMutation(
      lock,
      this.thread,
      creating,
      correlationId,
      navigation,
      tabInstanceId,
    );
    let response: MutationResponse;
    try {
      response = await runWork(work, mutation);
    } finally {
      mutation.finish();
    }
    if (mutation.isUnchanged) {
      // BIB-27 `m.unchanged()`: nothing was written through the mutation (StudyMutation refuses a
      // write before or after the declaration), so there is no revision to check, no event and no
      // counter to write. The caller still stores the response on the receipt and commits.
      if (mutation.eventsAppended !== 0 || lock.countersChanged) {
        throw new Error('MutationService: an unchanged mutation wrote counters');
      }
      lock.release();
      return response;
    }
    if (navigation && lock.contentRevision !== lock.lockedContentRevision) {
      throw new Error('MutationService: a navigation mutation changed the content revision');
    }
    if (!creating && !navigation && !mutation.revisionChecked) {
      throw new Error(
        'MutationService: work made no revision check (m.updateWithExpectedRevision)',
      );
    }
    if (mutation.eventsAppended === 0) {
      throw new Error('MutationService: work appended no StudyEvent (m.appendEvent)');
    }
    await this.studyRevisions.writeCounters(lock);
    lock.release();
    return response;
  }

  /**
   * Deletes the expired receipts of these owners (BIB-22), inside the caller's transaction (it
   * joins through the transaction context). The trash purge calls it for the owners whose studies
   * it purged: a receipt's stored response can hold the study's title, questions and tags, and
   * every receipt about a study purged 30 days after its last mutation (the trash) has expired
   * (7-day TTL), so this removes them all. An expired receipt replays nothing (a new claim takes
   * it over), so deleting one changes no behavior; a claim that is taking one over at the same
   * moment has already moved its `expires_at`, and PostgreSQL re-checks the condition after the
   * row lock, so it is kept. Owner-scoped; the general receipt purge belongs to the job runner
   * (BIB-39).
   */
  async deleteExpiredReceipts(ownerIds: readonly string[]): Promise<number> {
    if (activeTransaction() === undefined) {
      throw new Error('MutationService.deleteExpiredReceipts must run inside a transaction');
    }
    if (ownerIds.length === 0) return 0;
    return MutationReceipt.destroy({
      // The database clock, as the claim's own `expires_at <= now()` takeover test: a receipt
      // the database still holds live (it would replay) is never deleted, whatever the clock of
      // the process running the purge says.
      where: { ownerId: [...ownerIds], expiresAt: { [Op.lte]: fn('now') } },
    });
  }

  /** True when this transaction now owns the receipt row (new, or taken over from an expired one). */
  private async claim(
    transaction: Transaction,
    ownerId: string,
    idempotencyKey: string,
    request: MutationRequestInfo,
    requestHash: string,
  ): Promise<boolean> {
    // Raw SQL: Sequelize's upsert cannot express a conditional ON CONFLICT DO UPDATE … WHERE.
    const rows = await this.db.query(
      `INSERT INTO mutation_receipt
         (owner_id, idempotency_key, route, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now() + make_interval(days => $5))
       ON CONFLICT (owner_id, idempotency_key) DO UPDATE
         SET route = EXCLUDED.route,
             request_hash = EXCLUDED.request_hash,
             response_status = NULL,
             response_body = NULL,
             created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at
         WHERE mutation_receipt.expires_at <= now()
       RETURNING owner_id`,
      {
        bind: [
          ownerId,
          idempotencyKey,
          `${request.method} ${request.route}`,
          requestHash,
          RECEIPT_TTL_DAYS,
        ],
        transaction,
        type: QueryTypes.SELECT,
      },
    );
    return rows.length === 1;
  }

  private async replay(
    transaction: Transaction,
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MutationResult> {
    // READ COMMITTED (set on the transaction): this new statement sees the receipt the conflicting transaction committed.
    const receipt = await MutationReceipt.findOne({
      where: { ownerId, idempotencyKey },
      transaction,
    });
    if (!receipt || receipt.responseStatus === null || receipt.responseBody === null) {
      throw new Error('MutationService: an unclaimable receipt has no committed response');
    }
    if (receipt.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
    return new MutationResult(receipt.responseStatus, receipt.responseBody, true);
  }
}

/**
 * Runs the work and normalizes its response to exactly what JSON (and the stored jsonb) can
 * carry, so a first response and its replays have the same body.
 */
async function runWork(
  work: StudyMutationSpec['work'],
  mutation: StudyMutation,
): Promise<MutationResponse> {
  return normalized(await work(mutation));
}

function normalized({ status, body }: MutationResponse): MutationResponse {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new Error('MutationService: work must return a 2xx status');
  }
  const normalized: unknown = JSON.parse(JSON.stringify(body));
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('MutationService: work must return a JSON object body');
  }
  return { status, body: normalized as Record<string, unknown> };
}
