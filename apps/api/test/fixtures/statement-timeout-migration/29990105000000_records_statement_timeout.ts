import type { MigrationContext } from '../../../src/database/migrator';

// Test fixture only (never in MIGRATIONS_DIR): records the statement_timeout a migration runs
// under, so the test can check the migrator lifts the pool's request-sized timeout.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(
    `CREATE TABLE migration_timeout_probe AS SELECT current_setting('statement_timeout') AS v;`,
  );
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS migration_timeout_probe;`);
}
