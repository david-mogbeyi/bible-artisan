import type { MigrationContext } from '../../../src/database/migrator';

// Test fixture only (never in MIGRATIONS_DIR): creates a table and then indexes it in the same
// migration through the documented `context.query` API. Both statements must run on the
// migration's own transaction, or the CREATE INDEX would not see the uncommitted table.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`CREATE TABLE migration_index_probe (id integer PRIMARY KEY, label text);`);
  await context.query(
    `CREATE INDEX migration_index_probe_label_idx ON migration_index_probe (label);`,
  );
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS migration_index_probe;`);
}
