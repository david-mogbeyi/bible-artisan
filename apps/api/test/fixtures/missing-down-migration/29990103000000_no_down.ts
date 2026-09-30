import type { MigrationContext } from '../../../src/database/migrator';

// Test fixture only (never in MIGRATIONS_DIR): deliberately exports no `down`, so reverting it
// must fail loudly and keep its SequelizeMeta row instead of silently "reverting".
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`CREATE TABLE migration_no_down_probe (id integer PRIMARY KEY);`);
}
