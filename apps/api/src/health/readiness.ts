import { Logger } from '@nestjs/common';
import type { HealthResponse } from '@bible-artisan/contracts';
import { Client, type ClientConfig } from 'pg';
import { META_TABLE } from '../database/migrator';
import { errorTypeOf } from '../modules/observability/correlation';

/** The documented readiness budget: a probe always gets its answer (200 or 503) within this. */
export const READINESS_BUDGET_MS = 2000;

/**
 * Internal deadline for one readiness check: connect + query. Comfortably below the 2 s budget,
 * so routing, serialization, and the response itself still fit inside it. Applied as pg's
 * connect timeout, as the server-side `statement_timeout`, as pg's client-side query timeout,
 * and as an in-process deadline (whichever fires first wins; the others are backstops).
 */
export const READINESS_TIMEOUT_MS = 1500;

/**
 * How long one check's result answers later probes. A flood of probes costs at most one database
 * check per window, while a real outage or recovery still shows up within about a second.
 */
export const READINESS_CACHE_MS = 1000;

/** PostgreSQL `undefined_table`: no migration has ever run against this database. */
const UNDEFINED_TABLE = '42P01';

/** Error codes worth logging: SQLSTATEs and errno names, never free text. */
const SAFE_CODE = /^[A-Z0-9_]{1,24}$/;

export interface ReadinessResult {
  report: HealthResponse;
  /** Class name of what failed (e.g. `Error`, `ReadinessTimeout`, `MigrationsPending`), for logs. */
  failure?: string;
  /** SQLSTATE or socket error code of the failure, when it has one (`ECONNREFUSED`, `57P03`). */
  code?: string;
}

/**
 * The corpus release a build depends on (BIB-14): readiness requires exactly this release to be
 * imported and active, so a deployment whose `pnpm corpus:import` has not run is not ready.
 */
export interface CorpusPin {
  code: string;
  sourceRelease: string;
  artifactSha256: string;
}

const READY: HealthResponse = {
  status: 'ok',
  database: 'up',
  migrations: 'current',
  corpus: 'ready',
};
/** No migration table or corpus table yet: nothing past "pending" can be known. */
const NOTHING_MIGRATED: HealthResponse = {
  status: 'unavailable',
  database: 'up',
  migrations: 'pending',
  corpus: 'unknown',
};
const DB_DOWN: HealthResponse = {
  status: 'unavailable',
  database: 'down',
  migrations: 'unknown',
  corpus: 'unknown',
};

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

/**
 * One readiness check (BIB-13, BIB-14): PostgreSQL answers, every migration shipped with this build
 * is recorded in SequelizeMeta (a failed migration rolls back its record, so it stays missing), and
 * the pinned corpus release is active (an import is one transaction, so a failed one leaves none).
 *
 * Runs on its own short-lived pg client, never the request pool: a pool saturated by slow
 * requests must not make a healthy database look down, and a hung database must not leave probe
 * connections occupying request slots. One read-only statement, no transaction. Migrations the
 * database has but this build doesn't ship (a rollback of the code) don't count against
 * readiness. Never throws and never reports connection details or error text.
 */
export async function checkReadiness(
  connection: ClientConfig,
  shippedMigrations: readonly string[],
  corpus: CorpusPin,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid readiness timeout');

  const client = new Client({
    ...connection,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  });
  // A socket error after the check settled must not become an unhandled 'error' event.
  client.on('error', () => undefined);

  const check = (async (): Promise<ReadinessResult> => {
    await client.connect();
    try {
      // Names are unique (primary key), so the count equals the shipped list's length iff every
      // shipped migration is applied. A missing table (either one) is 42P01, handled below.
      const { rows } = await client.query<{ applied: number; corpus: boolean }>(
        `SELECT
           (SELECT count(*)::int FROM ${META_TABLE} WHERE name = ANY($1::text[])) AS applied,
           EXISTS (
             SELECT 1 FROM bible_edition
             WHERE code = $2 AND source_release = $3 AND artifact_sha256 = $4
               AND activated_at IS NOT NULL
           ) AS corpus`,
        [shippedMigrations, corpus.code, corpus.sourceRelease, corpus.artifactSha256],
      );
      const migrationsCurrent = rows[0]?.applied === shippedMigrations.length;
      const corpusReady = rows[0]?.corpus === true;
      const report: HealthResponse = {
        status: migrationsCurrent && corpusReady ? 'ok' : 'unavailable',
        database: 'up',
        migrations: migrationsCurrent ? 'current' : 'pending',
        corpus: corpusReady ? 'ready' : 'missing',
      };
      if (!migrationsCurrent) return { report, failure: 'MigrationsPending' };
      if (!corpusReady) return { report, failure: 'CorpusMissing' };
      return { report: READY };
    } catch (error) {
      if (codeOf(error) !== UNDEFINED_TABLE) throw error;
      return { report: NOTHING_MIGRATED, failure: 'MigrationsPending' };
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    // Promise.race subscribes to `check`, so a rejection after the deadline is still handled.
    const outcome = await Promise.race([check, deadline]);
    return outcome === 'timeout' ? { report: DB_DOWN, failure: 'ReadinessTimeout' } : outcome;
  } catch (error) {
    const code = codeOf(error);
    return { report: DB_DOWN, failure: errorTypeOf(error), ...(code ? { code } : {}) };
  } finally {
    clearTimeout(timer);
    // Not awaited: on a hung server, end() destroys the socket rather than waiting for a reply.
    client.end().catch(() => undefined);
  }
}

export interface ReadinessProbeOptions {
  timeoutMs?: number;
  cacheMs?: number;
}

/**
 * The readiness check as the HTTP route uses it: single-flight (concurrent probes share the one
 * in-flight check) and cached for `cacheMs` after it settles, so the probe endpoint, which is
 * public, can't be used to multiply load on the database. Logs a failed check once per check,
 * not once per probe, with its state, class, and code only.
 */
export class ReadinessProbe {
  private readonly logger = new Logger('Health');
  private inFlight?: Promise<ReadinessResult>;
  private cached?: { at: number; result: ReadinessResult };

  constructor(
    private readonly connection: ClientConfig,
    private readonly shippedMigrations: readonly string[],
    private readonly corpus: CorpusPin,
    private readonly options: ReadinessProbeOptions = {},
  ) {}

  check(): Promise<ReadinessResult> {
    if (this.inFlight) return this.inFlight;
    const cacheMs = this.options.cacheMs ?? READINESS_CACHE_MS;
    if (this.cached && Date.now() - this.cached.at < cacheMs) {
      return Promise.resolve(this.cached.result);
    }
    this.inFlight = checkReadiness(
      this.connection,
      this.shippedMigrations,
      this.corpus,
      this.options.timeoutMs,
    ).then((result) => {
      this.cached = { at: Date.now(), result };
      this.inFlight = undefined;
      if (result.report.status !== 'ok') {
        this.logger.warn('readiness_failed', {
          database: result.report.database,
          migrations: result.report.migrations,
          corpus: result.report.corpus,
          failure: result.failure,
          ...(result.code ? { code: result.code } : {}),
        });
      }
      return result;
    });
    return this.inFlight;
  }
}
