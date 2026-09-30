import { NO_MIGRATIONS } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database/database';
import { createMigrator, toError } from '../src/database/migrator';

/**
 * Proves every BIB-9 migration's `down` is real (not a no-op) and that rolling every
 * migration down then back up to latest succeeds, per AGENTS.md's "migrations must be
 * reversible" and this ticket's testing requirements. Runs against DATABASE_URL_TEST,
 * which global-setup.ts has already migrated to latest before this file runs.
 */
describe('migration reversibility', () => {
  it('rolls every migration down to none then back up to latest without error', async () => {
    const db = createDatabase(process.env.DATABASE_URL!);
    try {
      const migrator = createMigrator(db);

      const down = await migrator.migrateTo(NO_MIGRATIONS);
      if (down.error) throw toError(down.error);
      expect(down.results?.length).toBe(4);
      expect(down.results?.every((r) => r.status === 'Success' && r.direction === 'Down')).toBe(
        true,
      );

      const up = await migrator.migrateToLatest();
      if (up.error) throw toError(up.error);
      expect(up.results?.length).toBe(4);
      expect(up.results?.every((r) => r.status === 'Success' && r.direction === 'Up')).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});
