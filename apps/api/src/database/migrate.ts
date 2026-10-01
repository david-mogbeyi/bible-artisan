/* CLI: tsx src/database/migrate.ts <latest|down|make name> [--dir <migrations dir>] */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { runEntrypoint } from '../modules/observability/entrypoint';
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
  const args = process.argv.slice(2);
  // `--dir` runs another directory's migrations (the CLI's failure-logging test uses a fixture).
  const dirFlag = args.indexOf('--dir');
  const dir = dirFlag === -1 ? MIGRATIONS_DIR : path.resolve(args[dirFlag + 1] ?? '');
  const [command, name] = dirFlag === -1 ? args : args.slice(0, dirFlag);

  if (command === 'make') {
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      // Printed directly: a thrown error's message is deliberately never logged.
      console.log('Usage: make <snake_case_name>');
      process.exitCode = 1;
      return;
    }
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(dir, `${stamp}_${name}.ts`);
    writeFileSync(file, TEMPLATE, { flag: 'wx' });
    console.log(`created ${path.relative(process.cwd(), file)}`);
    return;
  }

  const db = createDatabase(loadEnv().DATABASE_URL);
  const migrator = createMigrator(db, { dir });
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

// A failure is logged as one content-free JSON line (migration name, error classes, SQLSTATE),
// never the error itself: its message and properties carry the SQL, bound parameters, and
// PostgreSQL `detail`, which quotes row values (NFR-PRIV-001). Exits 1.
void runEntrypoint('migrate', main);
