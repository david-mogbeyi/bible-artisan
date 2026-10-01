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
    // Deleting a user cascades to studies, and a study to its nodes, events and branches (BIB-19).
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
        name: 'study_branch_study_owner_fk',
        table: 'study_branch',
        columns: ['owner_id', 'study_id'],
        refs: ['owner_id', 'id'],
      },
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
      {
        name: 'study_tag_study_owner_fk',
        table: 'study_tag',
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
      db.query(`INSERT INTO study_node (study_id, owner_id, type) VALUES ($1, $2, 'thought')`, {
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

  async function insertNode(studyId: string, ownerId: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO study_node (study_id, owner_id, type, title, question_status)
       VALUES ($1, $2, 'question', 'Q', 'open') RETURNING id`,
      { bind: [studyId, ownerId], type: QueryTypes.SELECT },
    );
    if (!row) throw new Error('no node');
    return row.id;
  }

  it('rejects a study_branch whose owner or root node does not match its study (BIB-19)', async () => {
    const owner = await insertUser();
    const otherOwner = await insertUser();
    const studyId = await insertStudy(owner);
    const otherStudyId = await insertStudy(owner);
    const nodeId = await insertNode(studyId, owner);
    const otherStudyNodeId = await insertNode(otherStudyId, owner);
    const insertBranch = (study: string, branchOwner: string, root: string) =>
      db.query(`INSERT INTO study_branch (study_id, owner_id, root_node_id) VALUES ($1, $2, $3)`, {
        bind: [study, branchOwner, root],
        type: QueryTypes.INSERT,
      });

    await expect(insertBranch(studyId, otherOwner, nodeId)).rejects.toThrow(
      /study_branch_study_owner_fk/,
    );
    await expect(insertBranch(studyId, owner, otherStudyNodeId)).rejects.toThrow(
      /study_branch_root_node_fk/,
    );
    await expect(insertBranch(studyId, owner, nodeId)).resolves.toBeDefined();
  });

  it('only lets a study point at question nodes of its own study and owner (BIB-19)', async () => {
    const owner = await insertUser();
    const studyId = await insertStudy(owner);
    const otherStudyId = await insertStudy(owner);
    const nodeId = await insertNode(studyId, owner);
    const otherStudyNodeId = await insertNode(otherStudyId, owner);
    const point = (column: string, node: string) =>
      db.query(`UPDATE study SET ${column} = $2 WHERE id = $1`, {
        bind: [studyId, node],
        type: QueryTypes.UPDATE,
      });

    await expect(point('original_question_node_id', otherStudyNodeId)).rejects.toThrow(
      /study_original_question_node_fk/,
    );
    await expect(point('main_question_node_id', otherStudyNodeId)).rejects.toThrow(
      /study_main_question_node_fk/,
    );
    await expect(point('main_question_node_id', nodeId)).resolves.toBeDefined();
  });

  it('only lets a question pointer name a Question node, and pins the type of a node it names (BIB-19)', async () => {
    const owner = await insertUser();
    const studyId = await insertStudy(owner);
    const questionId = await insertNode(studyId, owner);
    const [thought] = await db.query<{ id: string }>(
      `INSERT INTO study_node (study_id, owner_id, type) VALUES ($1, $2, 'thought') RETURNING id`,
      { bind: [studyId, owner], type: QueryTypes.SELECT },
    );
    if (!thought) throw new Error('no node');
    const point = (column: string, node: string) =>
      db.query(`UPDATE study SET ${column} = $2 WHERE id = $1`, {
        bind: [studyId, node],
        type: QueryTypes.UPDATE,
      });

    await expect(point('original_question_node_id', thought.id)).rejects.toThrow(
      /study_original_question_node_fk/,
    );
    await expect(point('main_question_node_id', thought.id)).rejects.toThrow(
      /study_main_question_node_fk/,
    );
    await expect(
      db.query(`UPDATE study SET question_node_type = 'thought' WHERE id = $1`, {
        bind: [studyId],
      }),
    ).rejects.toThrow(/question_node_type" can only be updated to DEFAULT/);

    await point('main_question_node_id', questionId);
    // The type of a node a pointer names cannot change underneath it (node type is immutable).
    await expect(
      db.query(
        `UPDATE study_node SET type = 'thought', title = NULL, question_status = NULL WHERE id = $1`,
        { bind: [questionId] },
      ),
    ).rejects.toThrow(/study_main_question_node_fk/);
  });

  it('cascades hard deletes from user to study to every study-scoped row (BIB-19, BIB-20 tags)', async () => {
    const actions = await db.query<{ name: string; action: string }>(
      `SELECT conname AS name, confdeltype::text AS action
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid::regclass::text IN
              ('study', 'study_node', 'study_event', 'study_branch', 'mutation_receipt', 'auth_session',
               'tag', 'study_tag')
        ORDER BY conname`,
      { type: QueryTypes.SELECT },
    );
    // c = CASCADE, a = NO ACTION (checked at the end of the statement, after the cascade).
    expect(actions).toStrictEqual([
      { name: 'auth_session_user_id_fkey', action: 'c' },
      { name: 'mutation_receipt_owner_id_fkey', action: 'c' },
      { name: 'study_branch_root_node_fk', action: 'a' },
      { name: 'study_branch_study_owner_fk', action: 'c' },
      { name: 'study_event_study_owner_fk', action: 'c' },
      { name: 'study_main_question_node_fk', action: 'a' },
      { name: 'study_node_scripture_reference_id_fkey', action: 'a' },
      { name: 'study_node_study_owner_fk', action: 'c' },
      { name: 'study_original_question_node_fk', action: 'a' },
      { name: 'study_owner_id_fkey', action: 'c' },
      { name: 'study_starting_reference_id_fkey', action: 'a' },
      { name: 'study_tag_study_owner_fk', action: 'c' },
      { name: 'study_tag_tag_owner_fk', action: 'c' },
      { name: 'tag_owner_id_fkey', action: 'c' },
    ]);
  });

  it('refuses to hard-delete on its own a node that a question pointer or a branch names (BIB-19)', async () => {
    const owner = await insertUser();
    const studyId = await insertStudy(owner);
    const pointed = await insertNode(studyId, owner);
    const root = await insertNode(studyId, owner);
    await db.query(`UPDATE study SET main_question_node_id = $2 WHERE id = $1`, {
      bind: [studyId, pointed],
    });
    await db.query(
      `INSERT INTO study_branch (study_id, owner_id, root_node_id) VALUES ($1, $2, $3)`,
      { bind: [studyId, owner, root] },
    );
    await expect(
      db.query(`DELETE FROM study_node WHERE id = $1`, { bind: [pointed] }),
    ).rejects.toThrow(/study_main_question_node_fk/);
    await expect(
      db.query(`DELETE FROM study_node WHERE id = $1`, { bind: [root] }),
    ).rejects.toThrow(/study_branch_root_node_fk/);
  });

  it.each([
    ['an unknown type', `'note', NULL, NULL, NULL`, /study_node_type_check/],
    [
      'a question without a statement',
      `'question', NULL, 'open', NULL`,
      /study_node_question_check/,
    ],
    ['a question without a status', `'question', 'Q', NULL, NULL`, /study_node_question_check/],
    ['an unknown question status', `'question', 'Q', 'maybe', NULL`, /study_node_question_check/],
    ['an empty question statement', `'question', '', 'open', NULL`, /study_node_question_check/],
    [
      'a question status on a thought',
      `'thought', NULL, 'open', NULL`,
      /study_node_question_check/,
    ],
    [
      'a Scripture node without a reference',
      `'scripture', NULL, NULL, NULL`,
      /study_node_scripture_check/,
    ],
  ])('refuses %s in study_node (BIB-19)', async (_, values, constraint) => {
    const owner = await insertUser();
    const studyId = await insertStudy(owner);
    await expect(
      db.query(
        `INSERT INTO study_node (study_id, owner_id, type, title, question_status, scripture_reference_id)
         VALUES ($1, $2, ${values})`,
        { bind: [studyId, owner], type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow(constraint);
  });
});
