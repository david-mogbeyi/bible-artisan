import type { MigrationContext } from '../../../src/database/migrator';

/** Private-looking content the migrate CLI must never print (its test greps for it). */
export const SENTINEL = 'SENTINEL-migration-detail-6d1f0c2a';

// Test fixture only (never in MIGRATIONS_DIR): fails with a unique violation, so the error carries
// the sentinel in its message, its SQL, and PostgreSQL's `detail` ("Key (v)=(SENTINEL...) already
// exists"). The migrator's transaction rolls the table back.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`CREATE TABLE migration_leak_probe (v text PRIMARY KEY);`);
  await context.query(`INSERT INTO migration_leak_probe VALUES ('${SENTINEL}'), ('${SENTINEL}');`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS migration_leak_probe;`);
}
