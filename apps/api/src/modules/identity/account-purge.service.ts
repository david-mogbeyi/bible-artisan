import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, Transaction } from 'sequelize';
import type { Database } from '../../database/database';
import { DATABASE } from '../../database/database.module';

/** Accounts purged per transaction, so one run never holds many locks at once. */
export const ACCOUNT_PURGE_BATCH_SIZE = 20;

/**
 * The accounts to purge: every user whose deletion was confirmed, and every user row matching a
 * deletion tombstone (one a backup restore brought back). Skips rows another purge holds.
 */
const DUE_ACCOUNTS_SQL = `SELECT u.id, u.normalized_email AS "email"
    FROM "user" u
   WHERE u.deletion_requested_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM account_deletion d WHERE d.user_id = u.id)
   ORDER BY u.id
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

interface DueAccount {
  id: string;
  email: string;
}

/**
 * Purges deleted accounts (BIB-48; FR-PRIVACY-001; PRD sections 23, 29: "Purge live private data
 * and export objects within seven days", "Restoring a backup reapplies deletion tombstones before
 * serving users").
 *
 * Each batch is one transaction:
 * 1. Lock up to `ACCOUNT_PURGE_BATCH_SIZE` due users (`FOR UPDATE SKIP LOCKED`).
 * 2. Make sure each has a tombstone (`account_deletion`, which has no FK to `user` and so
 *    survives the purge), and mark it purged.
 * 3. Delete their sign-in challenges (keyed by email, not by user id).
 * 4. `DELETE FROM "user"`: every owner-scoped private table cascades from it (studies and all
 *    their children, tags, sessions, mutation receipts, export files).
 *
 * Their sessions were revoked and stop resolving the moment deletion was confirmed (or, for a
 * restored row, the moment its tombstone matches), so nothing is served in between. Idempotent;
 * the worker runs it on start and hourly, well inside the seven days.
 */
@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger('AccountPurge');

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async purgeDeleted(): Promise<number> {
    const started = Date.now();
    let purged = 0;
    for (;;) {
      const batch = await this.purgeBatch();
      purged += batch;
      if (batch < ACCOUNT_PURGE_BATCH_SIZE) break;
    }
    // Counts and duration only (NFR-PRIV-001).
    this.logger.log('accounts_purged', { accounts: purged, durationMs: Date.now() - started });
    return purged;
  }

  private purgeBatch(): Promise<number> {
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        const due = await this.db.query<DueAccount>(DUE_ACCOUNTS_SQL, {
          bind: [ACCOUNT_PURGE_BATCH_SIZE],
          transaction,
          type: QueryTypes.SELECT,
        });
        if (due.length === 0) return 0;
        const ids = due.map((account) => account.id);
        await this.db.query(
          `INSERT INTO account_deletion (user_id, requested_at, purged_at)
           SELECT u.id, COALESCE(u.deletion_requested_at, now()), now()
             FROM "user" u WHERE u.id = ANY($1::uuid[])
           ON CONFLICT (user_id) DO UPDATE SET purged_at = now()`,
          { bind: [ids], transaction },
        );
        await this.db.query(`DELETE FROM auth_challenge WHERE normalized_email = ANY($1::text[])`, {
          bind: [due.map((account) => account.email)],
          transaction,
        });
        await this.db.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, {
          bind: [ids],
          transaction,
        });
        return due.length;
      },
    );
  }
}
