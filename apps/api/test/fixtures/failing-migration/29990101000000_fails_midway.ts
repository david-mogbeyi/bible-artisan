import type { MigrationContext } from '../../../src/database/migrator';

// Test fixture only (never in MIGRATIONS_DIR): succeeds at its first statement, then fails, so the
// migrator's per-migration transaction must roll the first statement back.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);`);
  await context.query(`SELECT * FROM this_table_does_not_exist;`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS migration_rollback_probe;`);
}
