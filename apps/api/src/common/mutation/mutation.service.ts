import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, Transaction } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { MutationReceipt } from '../../database/models/mutation-receipt.model';
import { activeTransaction } from '../../database/transaction-context';
import {
  type NewStudy,
  type StudyLock,
  StudyRevisionService,
} from '../../modules/study/study-revision.service';
import { ThreadService } from '../../modules/thread/thread.service';
import { IdempotencyKeyReusedError } from '../errors/domain-errors';
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
   * The domain work. Must revision-check at least one row with `m.updateWithExpectedRevision`
   * and append at least one event with `m.appendEvent`. Every query joins the mutation
   * transaction automatically. Call no external provider.
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
 * 2. Lock the study row (`SELECT … FOR UPDATE`, owner-scoped: absent/foreign → 404). Every
 *    mutation of one study queues here before touching any child row, so mutations of one study
 *    cannot deadlock on each other's child rows.
 * 3. Run `work` with a `StudyMutation`. It must make ≥1 revision check and append ≥1 event;
 *    otherwise `execute` throws (a programming error, 500) and rolls everything back.
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
  ) {}

  async execute(
    ownerId: string,
    request: MutationRequestInfo,
    spec: StudyMutationSpec,
  ): Promise<MutationResult> {
    return this.transact(ownerId, request, async (transaction) => {
      const lock = await this.studyRevisions.lock(transaction, ownerId, spec.studyId);
      if (spec.bumpsContentRevision) lock.bumpContentRevision();
      return this.run(lock, spec.work, false);
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
      const lock = await this.studyRevisions.create(transaction, ownerId, spec.study);
      return this.run(lock, spec.work, true);
    });
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
  ): Promise<MutationResponse> {
    const mutation = new StudyMutation(lock, this.thread, creating);
    let response: MutationResponse;
    try {
      response = await runWork(work, mutation);
    } finally {
      mutation.finish();
    }
    if (!creating && !mutation.revisionChecked) {
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
  const { status, body } = await work(mutation);
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new Error('MutationService: work must return a 2xx status');
  }
  const normalized: unknown = JSON.parse(JSON.stringify(body));
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('MutationService: work must return a JSON object body');
  }
  return { status, body: normalized as Record<string, unknown> };
}
