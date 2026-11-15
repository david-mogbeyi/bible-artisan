import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_LIMIT_REACHED } from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import { LimitReachedError } from '../../common/errors/domain-errors';
import type { Database } from '../../database/database';
import { DATABASE } from '../../database/database.module';
import { SAFETY_LIMITS, type SafetyLimits } from './safety-limits';

/** Cached measurements kept at most; the oldest is dropped first beyond this. */
const MAX_CACHED_OWNERS = 10_000;

interface OwnedTable {
  name: string;
  hasStudyId: boolean;
}

/** Every table with an `owner_id` column, and whether it is study-scoped. */
const OWNED_TABLES_SQL = `SELECT c.table_name AS "name",
         bool_or(s.column_name IS NOT NULL) AS "hasStudyId"
    FROM information_schema.columns c
    LEFT JOIN information_schema.columns s
      ON s.table_schema = c.table_schema AND s.table_name = c.table_name
     AND s.column_name = 'study_id'
   WHERE c.table_schema = current_schema() AND c.column_name = 'owner_id'
   GROUP BY c.table_name
   ORDER BY c.table_name`;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Derived account storage (BIB-52; NFR-SCALE-002: "500MB derived account storage excluding
 * shared Bible text"): the stored size (`pg_column_size` of each row, so TOAST-compressed text
 * counts as stored) of every row the owner owns, in every table with an `owner_id` column. The
 * Bible corpus has no owner and never counts. Rows of a study in the trash do not count, so
 * moving a study to the trash makes room at once (the purge removes them 30 days later).
 *
 * Like the account purge, this reads every owner-scoped table in one SQL statement rather than
 * through each module's service: it is an account-wide size, not a read of any module's data,
 * and it returns one number. The table list comes from the catalog, so a new owner-scoped table
 * is counted without a change here.
 *
 * The measurement scans the owner's rows, so it is cached per owner for
 * `storageMeasureTtlMs` (in this process only: no new infrastructure, NFR rule 9); the cap is a
 * safety cap and may be overshot by what one window adds.
 */
@Injectable()
export class AccountStorageService {
  private readonly cache = new Map<string, { bytes: number; measuredAt: number }>();
  private tables: Promise<OwnedTable[]> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SAFETY_LIMITS) private readonly limits: SafetyLimits,
  ) {}

  get maxBytes(): number {
    return this.limits.maxAccountStorageBytes;
  }

  /** The owner's derived storage in bytes, measured at most `storageMeasureTtlMs` ago. */
  async usedBytes(ownerId: string): Promise<number> {
    const cached = this.cache.get(ownerId);
    const now = Date.now();
    if (cached && now - cached.measuredAt < this.limits.storageMeasureTtlMs) return cached.bytes;
    const bytes = await this.measure(ownerId);
    this.cache.delete(ownerId);
    this.cache.set(ownerId, { bytes, measuredAt: now });
    if (this.cache.size > MAX_CACHED_OWNERS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return bytes;
  }

  /** 422 `STORAGE_LIMIT_REACHED` when the owner's storage is at the cap. */
  async assertRoom(ownerId: string): Promise<void> {
    if ((await this.usedBytes(ownerId)) >= this.limits.maxAccountStorageBytes) {
      throw new LimitReachedError(STORAGE_LIMIT_REACHED);
    }
  }

  /** Drops the cached figure, so the next read measures (tests; after a large removal). */
  forget(ownerId: string): void {
    this.cache.delete(ownerId);
  }

  /** One statement over every owner-scoped table. */
  async measure(ownerId: string): Promise<number> {
    const tables = await this.ownedTables();
    const parts = tables.map(({ name, hasStudyId }) => {
      const table = quoteIdent(name);
      if (name === 'study') {
        return `SELECT sum(pg_column_size(t.*)) AS bytes FROM study t
                 WHERE t.owner_id = $1 AND t.lifecycle <> 'trashed'`;
      }
      const notTrashed = hasStudyId
        ? ` AND (t.study_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM study s
                    WHERE s.owner_id = t.owner_id AND s.id = t.study_id
                      AND s.lifecycle = 'trashed'))`
        : '';
      return `SELECT sum(pg_column_size(t.*)) AS bytes FROM ${table} t
               WHERE t.owner_id = $1${notTrashed}`;
    });
    if (parts.length === 0) return 0;
    const [row] = await this.db.query<{ bytes: string }>(
      `SELECT COALESCE(sum(bytes), 0)::bigint AS bytes FROM (${parts.join(' UNION ALL ')}) u`,
      { bind: [ownerId], type: QueryTypes.SELECT },
    );
    return Number(row?.bytes ?? 0);
  }

  private ownedTables(): Promise<OwnedTable[]> {
    this.tables ??= this.db
      .query<OwnedTable>(OWNED_TABLES_SQL, { type: QueryTypes.SELECT })
      .catch((error: unknown) => {
        this.tables = null;
        throw error;
      });
    return this.tables;
  }
}
