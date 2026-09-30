/* CLI: tsx src/database/migrate.ts <latest|down|make name> */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { createDatabase } from './database';
import { createMigrator, MIGRATIONS_DIR, toError } from './migrator';

const TEMPLATE = `import { sql, type Kysely } from 'kysely';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql\`\`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql\`\`.execute(db);
}
`;

async function main(): Promise<void> {
  const [command, name] = process.argv.slice(2);

  if (command === 'make') {
    if (!name || !/^[a-z0-9_]+$/.test(name)) throw new Error('Usage: make <snake_case_name>');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(MIGRATIONS_DIR, `${stamp}_${name}.ts`);
    writeFileSync(file, TEMPLATE, { flag: 'wx' });
    console.log(`created ${path.relative(process.cwd(), file)}`);
    return;
  }

  const db = createDatabase(loadEnv().DATABASE_URL);
  const migrator = createMigrator(db);
  try {
    const { error, results } =
      command === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
    for (const r of results ?? [])
      console.log(`${r.status.padEnd(8)} ${r.direction} ${r.migrationName}`);
    if (!results?.length) console.log('No migrations to run.');
    if (error) throw toError(error);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
