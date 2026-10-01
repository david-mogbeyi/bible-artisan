import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MutationService } from '../src/common/mutation/mutation.service';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { StudyEvent } from '../src/database/models/study-event.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { createTestApp } from './app';
import { MutationProbeModule } from './support/mutation-probe';

/** Pooled connections that exist now are dropped, so every later one runs the afterConnect hook. */
async function recyclePool(db: Database): Promise<void> {
  const { pool } = db.connectionManager as unknown as { pool: { destroyAllNow(): Promise<void> } };
  await pool.destroyAllNow();
}

/**
 * BIB-12: `MutationService` sets READ COMMITTED on its transaction explicitly. Its replay and
 * conditional-update logic depends on each statement seeing the latest committed rows, so it must
 * not inherit a stricter database or role default (e.g. SERIALIZABLE, under which the replay read
 * after a blocked receipt claim would fail with a serialization error instead of replaying).
 */
describe('mutation transaction isolation', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp(MutationProbeModule);
    db = app.get<Database>(DATABASE);
    userId = (await User.create({ normalizedEmail: `${randomUUID()}@example.test` })).id;
    // Every connection opened from here on defaults to SERIALIZABLE.
    db.addHook('afterConnect', 'serializableDefault', async (connection: unknown) => {
      await (connection as { query(sql: string): Promise<unknown> }).query(
        `SET default_transaction_isolation = 'serializable'`,
      );
    });
    await recyclePool(db);
  });

  afterAll(async () => {
    db.removeHook('afterConnect', 'serializableDefault');
    await recyclePool(db);
    await StudyEvent.destroy({ where: { ownerId: userId } });
    await Study.destroy({ where: { ownerId: userId } });
    await User.destroy({ where: { id: userId } });
    await app.close();
  });

  const isolation = async (): Promise<string | undefined> => {
    const [row] = await db.query<{ transaction_isolation: string }>('SHOW transaction_isolation', {
      type: QueryTypes.SELECT,
    });
    return row?.transaction_isolation;
  };

  it('runs mutations at READ COMMITTED even when the connection default is SERIALIZABLE', async () => {
    // The precondition really holds: an ordinary transaction now gets SERIALIZABLE.
    expect(await db.transaction(() => isolation())).toBe('serializable');

    const study = await Study.create({ ownerId: userId, title: 'Conscience' });
    const result = await app.get(MutationService).execute(
      userId,
      { idempotencyKey: randomUUID(), method: 'POST', route: '/x', params: {}, body: {} },
      {
        studyId: study.id,
        bumpsContentRevision: true,
        work: async (m) => {
          const seen = await isolation();
          await m.updateWithExpectedRevision(Study, {
            id: study.id,
            expectedRevision: 1,
            values: {},
          });
          await m.appendEvent({ eventType: 'study_renamed' });
          return { status: 200, body: { isolation: seen } };
        },
      },
    );
    expect(result.body).toStrictEqual({ isolation: 'read committed' });
  });
});
