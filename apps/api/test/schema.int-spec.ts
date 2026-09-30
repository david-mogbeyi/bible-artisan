import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database/database';
import { loadEnv } from '../src/config/env';

async function insertUser(db: Database): Promise<{ id: string }> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO "user" (id, normalized_email, timezone) VALUES ($1, $2, 'UTC') RETURNING id`,
    { bind: [randomUUID(), `${randomUUID()}@example.test`], type: QueryTypes.SELECT },
  );
  const row = rows[0];
  if (!row) throw new Error('insert did not return a row');
  return row;
}

describe('schema (composite-key owner isolation)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    await db.close();
  });

  it('creates user, study, study_node, and study_event with their composite FKs', async () => {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename IN ('user', 'study', 'study_node', 'study_event')
       ORDER BY tablename`,
      { type: QueryTypes.SELECT },
    );
    expect(tables.map((t) => t.tablename)).toStrictEqual([
      'study',
      'study_event',
      'study_node',
      'user',
    ]);
  });

  it('rejects a study_node insert whose owner_id does not match its study owner', async () => {
    const owner = await insertUser(db);
    const otherOwner = await insertUser(db);
    const studyId = randomUUID();
    await db.query(`INSERT INTO study (id, owner_id, title) VALUES ($1, $2, 'Study')`, {
      bind: [studyId, owner.id],
      type: QueryTypes.INSERT,
    });

    await expect(
      db.query(
        `INSERT INTO study_node (id, study_id, owner_id, type) VALUES ($1, $2, $3, 'scripture')`,
        { bind: [randomUUID(), studyId, otherOwner.id], type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow();
  });

  it('rejects a study_event insert whose owner_id does not match its study owner', async () => {
    const owner = await insertUser(db);
    const otherOwner = await insertUser(db);
    const studyId = randomUUID();
    await db.query(`INSERT INTO study (id, owner_id, title) VALUES ($1, $2, 'Study')`, {
      bind: [studyId, owner.id],
      type: QueryTypes.INSERT,
    });

    await expect(
      db.query(
        `INSERT INTO study_event (id, study_id, owner_id, sequence, event_type)
         VALUES ($1, $2, $3, 1, 'test')`,
        { bind: [randomUUID(), studyId, otherOwner.id], type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow();
  });
});
