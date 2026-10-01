import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MutationService } from '../src/common/mutation/mutation.service';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { createMigrator } from '../src/database/migrator';
import { StudyEvent } from '../src/database/models/study-event.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { createTestApp } from './app';
import { MutationProbeModule } from './support/mutation-probe';

const MIGRATION = '20261001074053_add_study_last_event_sequence.ts';

/**
 * BIB-12: adding `study.last_event_sequence` to a database whose studies already have events must
 * backfill each study's counter from max(study_event.sequence), so the next event continues the
 * sequence instead of colliding with an existing one on unique (study_id, sequence).
 */
describe('migration: study.last_event_sequence backfill', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp(MutationProbeModule);
    db = app.get<Database>(DATABASE);
    userId = (await User.create({ normalizedEmail: `${randomUUID()}@example.test` })).id;
  });

  afterAll(async () => {
    // Back to latest even if an assertion failed while the column was dropped.
    await createMigrator(db).up();
    await StudyEvent.destroy({ where: { ownerId: userId } });
    await Study.destroy({ where: { ownerId: userId } });
    await User.destroy({ where: { id: userId } });
    await app.close();
  });

  it('sets each study to its highest existing sequence, so the next mutation allocates max + 1', async () => {
    const migrator = createMigrator(db);
    await migrator.down({ to: MIGRATION });
    expect((await migrator.pending()).map((m) => m.name)).toStrictEqual([MIGRATION]);

    // Pre-migration data: a study with events (a gap included, so max ≠ count) and one without.
    const [withEvents, withoutEvents] = await Promise.all(
      ['With events', 'Without events'].map(async (title) => {
        const [row] = await db.query<{ id: string }>(
          `INSERT INTO study (owner_id, title) VALUES ($1, $2) RETURNING id`,
          { bind: [userId, title], type: QueryTypes.SELECT },
        );
        if (!row) throw new Error('study insert returned nothing');
        return row.id;
      }),
    );
    for (const sequence of [1, 2, 7]) {
      await db.query(
        `INSERT INTO study_event (study_id, owner_id, sequence, event_type) VALUES ($1, $2, $3, 'legacy')`,
        { bind: [withEvents, userId, sequence] },
      );
    }

    await migrator.up();

    const counters = await db.query<{ id: string; last_event_sequence: string }>(
      `SELECT id, last_event_sequence FROM study WHERE owner_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT },
    );
    expect(Object.fromEntries(counters.map((c) => [c.id, c.last_event_sequence]))).toStrictEqual({
      [withEvents as string]: '7',
      [withoutEvents as string]: '0',
    });

    const result = await app.get(MutationService).execute(
      userId,
      { idempotencyKey: null, method: 'POST', route: '/x', params: {}, body: {} },
      {
        studyId: withEvents as string,
        bumpsContentRevision: true,
        work: async (m) => {
          await m.updateWithExpectedRevision(Study, {
            id: m.studyId,
            expectedRevision: 1,
            values: {},
          });
          const event = await m.appendEvent({ eventType: 'study_renamed' });
          return { status: 200, body: { sequence: event.sequence } };
        },
      },
    );
    expect(result.body).toStrictEqual({ sequence: '8' });
  });
});
