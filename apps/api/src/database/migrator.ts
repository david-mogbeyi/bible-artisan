import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export function createMigrator<T>(db: Kysely<T>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
  });
}

/** Migrates to latest and throws on the first failure (each migration runs in its own transaction). */
export async function migrateToLatest<T>(db: Kysely<T>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') throw new Error(`Migration failed: ${r.migrationName}`);
  }
  if (error) throw toError(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Migration failed', { cause: error });
}
