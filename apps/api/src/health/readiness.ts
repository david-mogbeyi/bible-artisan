import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
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
 * The corpus release a build depends on (BIB-14): readiness requires exactly this release (same
 * artifact and same content checksum) to be imported and active, so a deployment whose
 * `pnpm corpus:import` has not run is not ready, and its stored text must still hash to
 * `contentSha256` (verified once per process; see `ReadinessProbe`).
 */
export interface CorpusPin {
  code: string;
  sourceRelease: string;
  artifactSha256: string;
  contentSha256: string;
}

export interface ReadinessCheckOptions {
  /**
   * Also recompute the active release's content checksum from its stored rows, in SQL, and report
   * `corpus: 'corrupt'` if it differs from the pin. About 40 ms on the full corpus, so it runs
   * once per process (`ReadinessProbe`), not on every probe.
   */
  verifyContent?: boolean;
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
 * the pinned corpus release is active (an import is one transaction, so a failed one leaves none)
 * with the pinned content checksum; with `verifyContent`, its stored text is also re-hashed.
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
  { verifyContent = false }: ReadinessCheckOptions = {},
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
      // `content` is NULL when the pinned release is not active; otherwise the stored checksum,
      // or with $6 the checksum recomputed from the stored rows.
      const { rows } = await client.query<{ applied: number; content: string | null }>(
        `SELECT
           (SELECT count(*)::int FROM ${META_TABLE} WHERE name = ANY($1::text[])) AS applied,
           (SELECT CASE WHEN $6::boolean THEN bible_edition_content_sha256(id)
                        ELSE content_sha256 END
            FROM bible_edition
            WHERE code = $2 AND source_release = $3 AND artifact_sha256 = $4
              AND content_sha256 = $5 AND activated_at IS NOT NULL
           ) AS content`,
        [
          shippedMigrations,
          corpus.code,
          corpus.sourceRelease,
          corpus.artifactSha256,
          corpus.contentSha256,
          verifyContent,
        ],
      );
      const migrationsCurrent = rows[0]?.applied === shippedMigrations.length;
      const content = rows[0]?.content ?? null;
      const corpusState =
        content === null ? 'missing' : content === corpus.contentSha256 ? 'ready' : 'corrupt';
      const report: HealthResponse = {
        status: migrationsCurrent && corpusState === 'ready' ? 'ok' : 'unavailable',
        database: 'up',
        migrations: migrationsCurrent ? 'current' : 'pending',
        corpus: corpusState,
      };
      if (!migrationsCurrent) return { report, failure: 'MigrationsPending' };
      if (corpusState === 'missing') return { report, failure: 'CorpusMissing' };
      if (corpusState === 'corrupt') return { report, failure: 'CorpusCorrupt' };
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
 *
 * Corpus integrity (BIB-14): at application bootstrap, before the API serves traffic, the active
 * release's content checksum is recomputed in SQL from the stored rows and compared with the pin.
 * The verdict is kept for the life of the process: `corrupt` makes every later probe 503
 * (`corpus: 'corrupt'`), `verified` is not re-checked. If the startup check could not reach a
 * verdict (database down, release not imported yet, timeout), the next probe that finds the
 * release active verifies it within its own single statement instead. Tampering after startup
 * (which needs the table owner to disable the immutability triggers) is caught on the next restart.
 */
export class ReadinessProbe implements OnApplicationBootstrap {
  private readonly logger = new Logger('Health');
  private inFlight?: Promise<ReadinessResult>;
  private cached?: { at: number; result: ReadinessResult };
  private integrity?: 'verified' | 'corrupt';

  constructor(
    private readonly connection: ClientConfig,
    private readonly shippedMigrations: readonly string[],
    private readonly corpus: CorpusPin,
    private readonly options: ReadinessProbeOptions = {},
  ) {}

  /** Nest lifecycle hook: the once-per-process integrity check, awaited before listening. */
  async onApplicationBootstrap(): Promise<void> {
    await this.verifyCorpusIntegrity();
  }

  /**
   * Recomputes the pinned release's content checksum (never throws). Does not touch the probe
   * cache. Logs one content-free `corpus_integrity` line with the verdict and its duration.
   */
  async verifyCorpusIntegrity(): Promise<void> {
    if (this.integrity) return;
    const started = Date.now();
    const result = await checkReadiness(
      this.connection,
      this.shippedMigrations,
      this.corpus,
      this.options.timeoutMs,
      { verifyContent: true },
    );
    this.recordIntegrity(result);
    const fields = { result: this.integrity ?? 'unverified', durationMs: Date.now() - started };
    if (this.integrity === 'corrupt') this.logger.error('corpus_integrity', fields);
    else this.logger.log('corpus_integrity', fields);
  }

  private recordIntegrity(result: ReadinessResult): void {
    if (result.report.corpus === 'ready') this.integrity = 'verified';
    if (result.report.corpus === 'corrupt') this.integrity = 'corrupt';
  }

  check(): Promise<ReadinessResult> {
    if (this.inFlight) return this.inFlight;
    const cacheMs = this.options.cacheMs ?? READINESS_CACHE_MS;
    if (this.cached && Date.now() - this.cached.at < cacheMs) {
      return Promise.resolve(this.cached.result);
    }
    const verifyContent = this.integrity === undefined;
    this.inFlight = checkReadiness(
      this.connection,
      this.shippedMigrations,
      this.corpus,
      this.options.timeoutMs,
      { verifyContent },
    ).then((checked) => {
      if (verifyContent) this.recordIntegrity(checked);
      const result = this.integrity === 'corrupt' ? asCorrupt(checked) : checked;
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

/** A check that found the release active, overridden by this process's `corrupt` verdict. */
function asCorrupt(result: ReadinessResult): ReadinessResult {
  if (result.report.corpus !== 'ready') return result;
  return {
    report: { ...result.report, status: 'unavailable', corpus: 'corrupt' },
    failure: result.failure ?? 'CorpusCorrupt',
  };
}
