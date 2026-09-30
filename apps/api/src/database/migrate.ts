/* CLI: tsx src/database/migrate.ts <latest|down|make name> */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { createDatabase } from './database';
import { createMigrator, MIGRATIONS_DIR } from './migrator';

const TEMPLATE = `import type { MigrationContext } from '../src/database/migrator';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
// Use raw queryInterface.sequelize.query(...) for anything the query-interface DSL can't express
// (composite FKs in particular — see ADR 0001's amendment).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(\`\`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(\`\`);
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
    // "down" reverts one step, matching the previous Kysely migrator's migrateDown() semantics.
    const results = command === 'down' ? await migrator.down() : await migrator.up();
    for (const r of results) console.log(`applied ${r.name}`);
    if (!results.length) console.log('No migrations to run.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
