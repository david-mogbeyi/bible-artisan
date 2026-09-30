import path from 'node:path';
import type { QueryInterface } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';
import type { Database } from './database';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export type MigrationContext = QueryInterface;

/**
 * sequelize-cli-style migrations (one TS file per change, `up`/`down` receiving the query
 * interface) run through Umzug's programmatic API, per ADR 0001's amendment ("use its
 * programmatic Umzug-based runner"). Applied migrations are tracked in a `SequelizeMeta` table in
 * the same database — no new infrastructure (AGENTS.md rule 9).
 */
export function createMigrator(db: Database): Umzug<MigrationContext> {
  return new Umzug({
    migrations: { glob: path.join(MIGRATIONS_DIR, '*.{ts,js}') },
    context: db.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize: db }),
    logger: undefined,
  });
}

/** Migrates to latest and throws on the first failure. */
export async function migrateToLatest(db: Database): Promise<void> {
  await createMigrator(db).up();
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Migration failed', { cause: error });
}
