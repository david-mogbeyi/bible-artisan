import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { createMigrator } from '../src/database/migrator';

/**
 * Automated migration-reversibility check (AGENTS.md: "Migrations must be reversible"; carried
 * forward from the closed Kysely PR's adversarial review, generalized to Umzug). Runs every
 * migration's `down` back to zero and then `up` back to latest, and asserts it completes without
 * error. Restores the schema to "latest" afterward so later test files in this same run still see
 * the tables global-setup already migrated.
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

  it('reverts every migration to zero and reapplies them to latest without error', async () => {
    const migrator = createMigrator(db);

    const executedBefore = await migrator.executed();
    expect(executedBefore.length).toBeGreaterThan(0);

    await expect(migrator.down({ to: 0 })).resolves.not.toThrow();

    const executedAfterDown = await migrator.executed();
    expect(executedAfterDown).toStrictEqual([]);

    const reapplied = await migrator.up();
    expect(reapplied.map((m) => m.name)).toStrictEqual(executedBefore.map((m) => m.name));

    const executedAfterUp = await migrator.executed();
    expect(executedAfterUp.map((m) => m.name)).toStrictEqual(executedBefore.map((m) => m.name));
  });
});
