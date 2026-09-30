import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database/database';
import { loadEnv } from '../src/config/env';

describe('schema (composite-key owner isolation)', () => {
  let db: Database;
  const created = { users: [] as string[], studies: [] as string[] };

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO "user" (id, normalized_email) VALUES ($1, $2)`, {
      bind: [id, `${randomUUID()}@example.test`],
      type: QueryTypes.INSERT,
    });
    created.users.push(id);
    return id;
  }

  async function insertStudy(ownerId: string): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO study (id, owner_id, title) VALUES ($1, $2, 'Study')`, {
      bind: [id, ownerId],
      type: QueryTypes.INSERT,
    });
    created.studies.push(id);
    return id;
  }

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    const bind = [created.studies];
    await db.query(`DELETE FROM study_event WHERE study_id = ANY($1)`, { bind });
    await db.query(`DELETE FROM study_node WHERE study_id = ANY($1)`, { bind });
    await db.query(`DELETE FROM study WHERE id = ANY($1)`, { bind });
    await db.query(`DELETE FROM "user" WHERE id = ANY($1)`, { bind: [created.users] });
    await db.close();
  });

  it('creates user, study, study_node, and study_event', async () => {
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

  it('only allows foreign keys into study through the composite (owner_id, id) key', async () => {
    // Guard for AGENTS.md rule 2: `study.id` is a primary key, so a new FK to `study (id)` alone
    // would be accepted by PostgreSQL and silently bypass owner isolation. Fail loudly instead.
    const fks = await db.query<{ name: string; table: string; columns: string[]; refs: string[] }>(
      `SELECT c.conname AS name,
              c.conrelid::regclass::text AS table,
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns,
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS refs
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'public.study'::regclass
        ORDER BY c.conname`,
      { type: QueryTypes.SELECT },
    );

    expect(fks).toStrictEqual([
      {
        name: 'study_event_study_owner_fk',
        table: 'study_event',
        columns: ['owner_id', 'study_id'],
        refs: ['owner_id', 'id'],
      },
      {
        name: 'study_node_study_owner_fk',
        table: 'study_node',
        columns: ['owner_id', 'study_id'],
        refs: ['owner_id', 'id'],
      },
    ]);
  });

  it('rejects a study_node insert whose owner_id does not match its study owner', async () => {
    const owner = await insertUser();
    const otherOwner = await insertUser();
    const studyId = await insertStudy(owner);

    await expect(
      db.query(`INSERT INTO study_node (study_id, owner_id, type) VALUES ($1, $2, 'scripture')`, {
        bind: [studyId, otherOwner],
        type: QueryTypes.INSERT,
      }),
    ).rejects.toThrow(/study_node_study_owner_fk/);
  });

  it('rejects a study_event insert whose owner_id does not match its study owner', async () => {
    const owner = await insertUser();
    const otherOwner = await insertUser();
    const studyId = await insertStudy(owner);

    await expect(
      db.query(
        `INSERT INTO study_event (study_id, owner_id, sequence, event_type)
         VALUES ($1, $2, 1, 'test')`,
        { bind: [studyId, otherOwner], type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow(/study_event_study_owner_fk/);
  });
});
