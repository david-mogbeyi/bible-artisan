/* CLI: tsx src/database/migrate.ts <latest|down|make name> */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { createDatabase } from './database';
import { createMigrator, MIGRATIONS_DIR } from './migrator';

const TEMPLATE = `import type { MigrationContext } from '../src/database/migrator';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
// Run every statement through context.query(...): it is bound to this migration's transaction, so
// the whole migration (and its SequelizeMeta row) commits or rolls back as one unit.
// Both up and down are required; the migrator refuses to run a missing step.
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
    // "down" reverts exactly one step (the most recently applied migration).
    const results = command === 'down' ? await migrator.down() : await migrator.up();
    const verb = command === 'down' ? 'reverted' : 'applied';
    for (const r of results) console.log(`${verb} ${r.name}`);
    if (!results.length) console.log('No migrations to run.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
