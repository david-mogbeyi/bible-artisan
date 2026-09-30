import { readdirSync } from 'node:fs';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { createMigrator, MIGRATIONS_DIR } from '../src/database/migrator';

const DOMAIN_TABLES = ['study', 'study_event', 'study_node', 'user'];

async function publicTables(db: Database, names: string[]): Promise<string[]> {
  const rows = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1)
     ORDER BY tablename`,
    { bind: [names], type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.tablename);
}

async function recordedMigrations(db: Database): Promise<string[]> {
  const rows = await db.query<{ name: string }>(`SELECT name FROM "SequelizeMeta" ORDER BY name`, {
    type: QueryTypes.SELECT,
  });
  return rows.map((r) => r.name);
}

/**
 * Automated migration-reversibility check (AGENTS.md: "Migrations must be reversible"). Runs every
 * migration's `down` back to zero, checks the schema and SequelizeMeta are really empty, then
 * `up` back to latest and checks everything is back and recorded. Restores "latest" afterward so
 * later test files in this run still see the tables. Note: dropping to zero also clears any rows
 * earlier runs left behind in the test database.
 */
describe('migration reversibility', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    // Guarantee latest is restored even if an assertion above throws mid-test.
    await createMigrator(db).up();
    await db.close();
  });

  it('reverts every migration to zero, then reapplies them all to latest', async () => {
    const migrator = createMigrator(db);
    // Expected set comes from the filesystem, independent of the migrator's own bookkeeping.
    const allNames = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /\.(ts|js)$/.test(f))
      .sort();
    expect(allNames.length).toBeGreaterThan(0);
    expect(await recordedMigrations(db)).toStrictEqual(allNames);
    expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(DOMAIN_TABLES);

    const reverted = await migrator.down({ to: 0 });
    expect(reverted.map((m) => m.name)).toStrictEqual([...allNames].reverse());
    expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual([]);
    expect(await recordedMigrations(db)).toStrictEqual([]);
    expect(await migrator.pending()).toHaveLength(allNames.length);

    const reapplied = await migrator.up();
    expect(reapplied.map((m) => m.name)).toStrictEqual(allNames);
    expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(DOMAIN_TABLES);
    expect(await recordedMigrations(db)).toStrictEqual(allNames);
    expect(await migrator.pending()).toStrictEqual([]);
  });

  it('rolls a migration that fails midway back completely and does not record it', async () => {
    const before = await recordedMigrations(db);
    const failing = createMigrator(db, {
      glob: path.join(__dirname, 'fixtures/failing-migration/*.ts'),
    });

    await expect(failing.up()).rejects.toThrow(/29990101000000_fails_midway/);

    // Its first statement (CREATE TABLE) was rolled back with the failing one.
    expect(await publicTables(db, ['migration_rollback_probe'])).toStrictEqual([]);
    expect(await recordedMigrations(db)).toStrictEqual(before);
  });
});
