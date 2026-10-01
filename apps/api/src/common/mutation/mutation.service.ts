import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { MutationReceipt } from '../../database/models/mutation-receipt.model';
import { IdempotencyKeyReusedError } from '../errors/domain-errors';
import { requestFingerprint } from './fingerprint';
import type { MutationRequestInfo } from './mutation-request';

/** PRD §23: receipts are kept seven days, the supported lifetime of a client's offline queue. */
export const RECEIPT_TTL_DAYS = 7;

/** What a mutation's work returns: a 2xx status and a JSON object body. */
export interface MutationResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface MutationResult extends MutationResponse {
  /** True when this is a stored response replayed for a retry; the work did not run. */
  replayed: boolean;
}

/** The domain work of one mutation. Do every write on `transaction`; call no external provider. */
export type MutationWork = (transaction: Transaction) => Promise<MutationResponse>;

/**
 * Runs one mutation exactly once per (owner, Idempotency-Key) (PRD §23, §24, §27; FR-STUDY-002).
 *
 * Everything happens in ONE transaction, and `execute` resolves only after COMMIT returns, so a
 * caller can never acknowledge ("Saved") work that is not durable (NFR-REL-001):
 *
 * 1. Claim the receipt: INSERT (owner_id, key) … ON CONFLICT DO UPDATE only when the existing
 *    row has expired. If another request with the same key is still in flight, PostgreSQL makes
 *    this INSERT wait on that transaction's uncommitted unique-index entry. When it commits, the
 *    claim fails and we replay its response; when it rolls back, the claim succeeds and we run.
 *    No duplicate execution and no "in progress" error state.
 * 2. Not claimed → read the committed receipt. Same fingerprint → return its status and body
 *    (`replayed: true`). Different fingerprint → 422 `IdempotencyKeyReusedError`.
 * 3. Claimed → run the work in the transaction, store its status and body on the receipt, commit.
 *
 * Any error thrown by the work (404, 409, 422, …) or by COMMIT rolls back the receipt with the
 * domain writes and events, so failures are never cached and a retry with the same key re-runs.
 * Without a key the work simply runs in a transaction.
 *
 * Receipts are keyed by owner, so the same key value from two users never collides or replays
 * across them. `ownerId` must come from the session.
 */
@Injectable()
export class MutationService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(
    ownerId: string,
    request: MutationRequestInfo,
    work: MutationWork,
  ): Promise<MutationResult> {
    return this.db.transaction(async (transaction) => {
      const { idempotencyKey } = request;
      if (idempotencyKey === null) {
        return { ...(await runWork(work, transaction)), replayed: false };
      }

      const requestHash = requestFingerprint(request);
      const claimed = await this.claim(transaction, ownerId, idempotencyKey, request, requestHash);
      if (!claimed) return this.replay(transaction, ownerId, idempotencyKey, requestHash);

      const response = await runWork(work, transaction);
      await MutationReceipt.update(
        { responseStatus: response.status, responseBody: response.body },
        { where: { ownerId, idempotencyKey }, transaction },
      );
      return { ...response, replayed: false };
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
          `${request.method} ${request.path}`,
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
    // READ COMMITTED: this new statement sees the receipt the conflicting transaction committed.
    const receipt = await MutationReceipt.findOne({
      where: { ownerId, idempotencyKey },
      transaction,
    });
    if (!receipt || receipt.responseStatus === null || receipt.responseBody === null) {
      throw new Error('MutationService: an unclaimable receipt has no committed response');
    }
    if (receipt.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
    return { status: receipt.responseStatus, body: receipt.responseBody, replayed: true };
  }
}

/**
 * Runs the work and normalizes its response to exactly what JSON (and the stored jsonb) can
 * carry, so a first response and its replays have the same body.
 */
async function runWork(work: MutationWork, transaction: Transaction): Promise<MutationResponse> {
  const { status, body } = await work(transaction);
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new Error('MutationService: work must return a 2xx status');
  }
  const normalized: unknown = JSON.parse(JSON.stringify(body));
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('MutationService: work must return a JSON object body');
  }
  return { status, body: normalized as Record<string, unknown> };
}
