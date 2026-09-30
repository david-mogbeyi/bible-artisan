import path from 'node:path';
import { QueryTypes, type QueryInterface, type Transaction } from 'sequelize';
import { Umzug, type UmzugStorage } from 'umzug';
import type { Database } from './database';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** Same table name/shape umzug's SequelizeStorage uses, so existing databases stay compatible. */
const META_TABLE = '"SequelizeMeta"';

/**
 * What each migration's `up`/`down` receives. Everything here is bound to the migration's own
 * transaction: use `query` for raw SQL DDL; if you reach for `queryInterface`, pass
 * `{ transaction }` explicitly or the statement runs outside the transaction.
 */
export interface MigrationContext {
  query(sql: string): Promise<void>;
  queryInterface: QueryInterface;
  transaction: Transaction;
}

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
 * sequelize-cli-style migrations (one TS file per change, `up`/`down`) run through Umzug's
 * programmatic API, per ADR 0001's amendment. Each migration's DDL and its SequelizeMeta
 * insert/delete commit in ONE transaction (PostgreSQL DDL is transactional), so a failure midway
 * rolls back completely instead of leaving a half-applied or applied-but-unrecorded migration.
 * No new infrastructure (AGENTS.md rule 9).
 */
export function createMigrator(
  db: Database,
  { glob = path.join(MIGRATIONS_DIR, '*.{ts,js}') }: { glob?: string } = {},
): Umzug<Database> {
  return new Umzug<Database>({
    migrations: {
      glob,
      resolve: (params) => {
        const loaded = Umzug.defaultResolver(params);
        const run = (direction: 'up' | 'down') => async (): Promise<void> => {
          const step = direction === 'up' ? loaded.up : loaded.down;
          if (!step) throw new Error(`Migration ${params.name} has no ${direction}()`);
          await db.transaction(async (transaction) => {
            const context: MigrationContext = {
              query: async (sql) => {
                await db.query(sql, { transaction });
              },
              queryInterface: db.getQueryInterface(),
              transaction,
            };
            await step({ name: params.name, path: params.path, context });
            await db.query(
              direction === 'up'
                ? `INSERT INTO ${META_TABLE} (name) VALUES ($1)`
                : `DELETE FROM ${META_TABLE} WHERE name = $1`,
              { bind: [params.name], transaction },
            );
          });
        };
        return { name: loaded.name, path: loaded.path, up: run('up'), down: run('down') };
      },
    },
    context: db,
    storage: createMetaStorage(db),
    logger: undefined,
  });
}

/** Migrates to latest and throws on the first failure. */
export async function migrateToLatest(db: Database): Promise<void> {
  await createMigrator(db).up();
}
