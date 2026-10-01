import type { HealthResponse } from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import type { Database } from '../database/database';
import { errorTypeOf } from '../modules/observability/correlation';

/**
 * Upper bound on one readiness check. Applied twice: as the server-side `statement_timeout` (so a
 * slow query is cancelled in PostgreSQL) and as an in-process deadline (so an unreachable or
 * hung server, where no statement ever starts, still gets an answer in time).
 */
export const READINESS_TIMEOUT_MS = 2000;

export interface ReadinessResult {
  report: HealthResponse;
  /** Class name of what failed (e.g. `ConnectionRefusedError`, `ReadinessTimeout`), for logs. */
  failure?: string;
}

const NOT_READY_DB_DOWN: HealthResponse = {
  status: 'unavailable',
  database: 'down',
  migrations: 'unknown',
};

/**
 * Readiness (BIB-13): PostgreSQL answers, and every migration shipped with this build is recorded
 * in SequelizeMeta (a failed migration rolls back its record, so it stays missing). Read-only.
 * Migrations the database has but this build doesn't ship (a rollback of the code) don't count
 * against readiness. Never throws and never reports connection details or error text.
 */
export async function checkReadiness(
  db: Database,
  shippedMigrations: readonly string[],
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid readiness timeout');

  const applied = db.transaction(async (transaction) => {
    await db.query(`SET LOCAL statement_timeout = ${timeoutMs}`, { transaction });
    const [meta] = await db.query<{ present: boolean }>(
      `SELECT to_regclass('"SequelizeMeta"') IS NOT NULL AS present`,
      { type: QueryTypes.SELECT, transaction },
    );
    if (meta?.present !== true) return new Set<string>();
    const rows = await db.query<{ name: string }>('SELECT name FROM "SequelizeMeta"', {
      type: QueryTypes.SELECT,
      transaction,
    });
    return new Set(rows.map((row) => row.name));
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    // Promise.race subscribes to `applied`, so a rejection after the deadline is still handled.
    const outcome = await Promise.race([applied, deadline]);
    if (outcome === 'timeout') return { report: NOT_READY_DB_DOWN, failure: 'ReadinessTimeout' };
    const current = shippedMigrations.every((name) => outcome.has(name));
    return current
      ? { report: { status: 'ok', database: 'up', migrations: 'current' } }
      : {
          report: { status: 'unavailable', database: 'up', migrations: 'pending' },
          failure: 'MigrationsPending',
        };
  } catch (error) {
    return { report: NOT_READY_DB_DOWN, failure: errorTypeOf(error) };
  } finally {
    clearTimeout(timer);
  }
}
