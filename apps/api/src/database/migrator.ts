import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { Umzug, type UmzugStorage } from 'umzug';
import type { Database } from './database';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** A migration file: one `.ts` (source) or `.js` (built) module per migration. */
const MIGRATION_FILE = /\.(ts|js)$/;

/**
 * The migration names a directory ships (file names, as recorded in SequelizeMeta), in order.
 * The single source of the migration list: the migrator runs exactly these, and the readiness
 * probe compares them with SequelizeMeta without going through Umzug (whose storage creates the
 * table if it is missing). Throws if the directory is unreadable, so an API deployed without its
 * migrations fails at startup instead of reporting itself ready.
 */
export function shippedMigrationNames(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort();
}

/**
 * The applied-migrations table, quoted for SQL. Same table name/shape umzug's SequelizeStorage
 * uses, so existing databases stay compatible. Shared with the readiness probe.
 */
export const META_TABLE = '"SequelizeMeta"';

/**
 * What each migration's `up`/`down` receives. `query` is the only way to run SQL and it is always
 * bound to the migration's own transaction, so every statement commits or rolls back together
 * with the SequelizeMeta bookkeeping. Deliberately no `queryInterface`/`sequelize` handle: a
 * statement issued through one runs on a different pool connection outside the transaction
 * (deadlocking on the migration's own locks, or missing its uncommitted tables).
 */
export interface MigrationContext {
  query(sql: string): Promise<void>;
  /**
   * A read-only lookup in the same transaction (e.g. `SELECT current_schema()`), for migrations
   * whose DDL depends on the database they run in. Never use it to splice data into DDL.
   */
  select<T extends object>(sql: string): Promise<T[]>;
}

type MigrationFn = (params: {
  name: string;
  path?: string;
  context: MigrationContext;
}) => Promise<void>;

/**
 * Loads migration files the same way Umzug's default resolver does (Node's `require`; .ts works
 * through Node's built-in type stripping or the tsx loader), but lets us inspect the exports.
 */
const loadMigrationModule = createRequire(__filename) as (id: string) => Record<string, unknown>;

/**
 * Reads applied migrations from SequelizeMeta. Writes are no-ops here because the resolver
 * below records/unrecords each migration inside that migration's own transaction.
 */
function createMetaStorage(db: Database): UmzugStorage {
  const ensureTable = (): Promise<unknown> =>
    db.query(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (name varchar(255) NOT NULL, PRIMARY KEY (name))`,
    );
  return {
    async executed(): Promise<string[]> {
      await ensureTable();
      const rows = await db.query<{ name: string }>(
        `SELECT name FROM ${META_TABLE} ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
      return rows.map((r) => r.name);
    },
    async logMigration(): Promise<void> {},
    async unlogMigration(): Promise<void> {},
  };
}

/**
 * Migrations (one TS file per change, exporting `up` and `down`) run through Umzug's
 * programmatic API, per ADR 0001's amendment. Each migration's DDL and its SequelizeMeta
 * insert/delete commit in ONE transaction (PostgreSQL DDL is transactional), so a failure midway
 * rolls back completely instead of leaving a half-applied or applied-but-unrecorded migration.
 * No new infrastructure (AGENTS.md rule 9).
 */
export function createMigrator(
  db: Database,
  { dir = MIGRATIONS_DIR }: { dir?: string } = {},
): Umzug<Database> {
  return new Umzug<Database>({
    // Custom resolution (not Umzug.defaultResolver, whose `down` silently no-ops when the export
    // is missing): a migration without the requested step fails loudly BEFORE its transaction
    // opens, so SequelizeMeta is left untouched.
    migrations: shippedMigrationNames(dir).map((name) => {
      const filePath = path.join(dir, name);
      const run = (direction: 'up' | 'down') => async (): Promise<void> => {
        const step = loadMigrationModule(filePath)[direction];
        if (typeof step !== 'function') {
          throw new Error(`Migration ${name} does not export ${direction}()`);
        }
        await db.transaction(async (transaction) => {
          // DDL and backfills may legitimately run longer than the pool's request-sized
          // statement_timeout (see DATABASE_TIMEOUTS), so a migration lifts it for its own
          // transaction only.
          await db.query('SET LOCAL statement_timeout = 0', { transaction });
          const context: MigrationContext = {
            query: async (sql) => {
              await db.query(sql, { transaction });
            },
            select: <T extends object>(sql: string) =>
              db.query<T>(sql, { type: QueryTypes.SELECT, transaction }),
          };
          await (step as MigrationFn)({ name, path: filePath, context });
          await db.query(
            direction === 'up'
              ? `INSERT INTO ${META_TABLE} (name) VALUES ($1)`
              : `DELETE FROM ${META_TABLE} WHERE name = $1`,
            { bind: [name], transaction },
          );
        });
      };
      return { name, path: filePath, up: run('up'), down: run('down') };
    }),
    context: db,
    storage: createMetaStorage(db),
    logger: undefined,
  });
}

/** Migrates to latest and throws on the first failure. */
export async function migrateToLatest(db: Database): Promise<void> {
  await createMigrator(db).up();
}
