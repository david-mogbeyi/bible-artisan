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
        name: 'annotation_study_owner_fk',
        table: 'annotation',
        columns: ['owner_id', 'study_id'],
        refs: ['owner_id', 'id'],
      },
      {
        name: 'note_study_owner_fk',
        table: 'note',
        columns: ['owner_id', 'study_id'],
        refs: ['owner_id', 'id'],
      },
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

  it('backs every composite FK into study with a full (non-partial) index on its columns, so a study purge cascades by index', async () => {
    // A partial index (e.g. live rows only) cannot serve the cascade, which must also find the
    // soft-deleted children; without a full index each purged study scans the child table
    // (BIB-24: `annotation` had only its partial chapter index).
    const unindexed = await db.query<{ name: string }>(
      `SELECT c.conname AS name
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'public.study'::regclass
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid AND i.indpred IS NULL
               AND (
                 -- Led by the column referencing study.id (unique, so enough on its own) …
                 (i.indkey::int2[])[0] = c.conkey[array_position(c.confkey, (
                   SELECT attnum FROM pg_attribute
                    WHERE attrelid = 'public.study'::regclass AND attname = 'id'))]
                 -- … or by all of the FK's columns, in any order.
                 OR ((i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                     AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)))
        ORDER BY c.conname`,
      { type: QueryTypes.SELECT },
    );
    expect(unindexed).toStrictEqual([]);

    // And the planner uses it for the cascade's lookup (sequential scans priced out, as on a
    // large table): the annotation cascade reads `annotation_study_idx`.
    const plan = await db.transaction(async (transaction) => {
      await db.query('SET LOCAL enable_seqscan = off', { transaction });
      return db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM annotation WHERE owner_id = $1 AND study_id = $2`,
        { bind: [randomUUID(), randomUUID()], transaction, type: QueryTypes.SELECT },
      );
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toMatch(/annotation_study_idx/);
  });

  it('rejects a study_node insert whose owner_id does not match its study owner', async () => {
    const owner = await insertUser();
    const otherOwner = await insertUser();
    const studyId = await insertStudy(owner);

    await expect(
      db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         VALUES ($1, $2, 'thought', 'user', 'T')`,
        {
          bind: [studyId, otherOwner],
          type: QueryTypes.INSERT,
        },
      ),
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
      `INSERT INTO study_node (study_id, owner_id, type, origin, title, question_status)
       VALUES ($1, $2, 'question', 'user', 'Q', 'open') RETURNING id`,
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
      `INSERT INTO study_node (study_id, owner_id, type, origin, body)
       VALUES ($1, $2, 'thought', 'user', 'T') RETURNING id`,
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
    // The type of a node a pointer names cannot change underneath it (node type is immutable):
    // since BIB-25 the identity trigger refuses any type change first; the FK stays the backstop.
    await expect(
      db.query(
        `UPDATE study_node SET type = 'thought', title = NULL, question_status = NULL, body = 'T'
          WHERE id = $1`,
        { bind: [questionId] },
      ),
    ).rejects.toThrow(/type, study, owner, origin and reference are immutable/);
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
      { name: 'study_node_canonical_node_fk', action: 'a' },
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

  // Columns: type, origin, title, question_status, scripture_reference_id, body,
  // observation_kind, conclusion_status, payload_json. Each row breaks exactly one rule.
  it.each([
    [
      'an unknown type',
      `'note', 'user', NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_type_check/,
    ],
    [
      'a question without a statement',
      `'question', 'user', NULL, 'open', NULL, NULL, NULL, NULL, NULL`,
      /study_node_title_check/,
    ],
    [
      'a question without a status',
      `'question', 'user', 'Q', NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_question_check/,
    ],
    [
      'an unknown question status',
      `'question', 'user', 'Q', 'maybe', NULL, NULL, NULL, NULL, NULL`,
      /study_node_question_check/,
    ],
    [
      'an empty question statement',
      `'question', 'user', '', 'open', NULL, NULL, NULL, NULL, NULL`,
      /study_node_title_check/,
    ],
    [
      'a question status on a thought',
      `'thought', 'user', NULL, 'open', NULL, 'T', NULL, NULL, NULL`,
      /study_node_question_check/,
    ],
    [
      'a Scripture node without a reference',
      `'scripture', 'scripture', NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_scripture_check/,
    ],
    // BIB-25: origin and the four remaining types.
    [
      'an unknown origin',
      `'thought', 'robot', NULL, NULL, NULL, 'T', NULL, NULL, NULL`,
      /study_node_origin_check/,
    ],
    [
      'no origin',
      `'thought', NULL, NULL, NULL, NULL, 'T', NULL, NULL, NULL`,
      /null value in column "origin"/,
    ],
    [
      'a thought without text',
      `'thought', 'user', NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_body_check/,
    ],
    [
      'a thought over 10,000 characters',
      `'thought', 'user', NULL, NULL, NULL, repeat('x', 10001), NULL, NULL, NULL`,
      /study_node_body_check/,
    ],
    [
      'a title on a thought',
      `'thought', 'user', 'T', NULL, NULL, 'T', NULL, NULL, NULL`,
      /study_node_title_check/,
    ],
    [
      'text on a question',
      `'question', 'user', 'Q', 'open', NULL, 'T', NULL, NULL, NULL`,
      /study_node_body_check/,
    ],
    [
      'an observation without a kind',
      `'observation', 'user', NULL, NULL, NULL, 'O', NULL, NULL, NULL`,
      /study_node_observation_check/,
    ],
    [
      'an observation kind on a thought',
      `'thought', 'user', NULL, NULL, NULL, 'T', 'interpretation', NULL, NULL`,
      /study_node_observation_check/,
    ],
    [
      'a conclusion without a status',
      `'conclusion', 'user', 'C', NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_conclusion_check/,
    ],
    [
      'an unknown conclusion status',
      `'conclusion', 'user', 'C', NULL, NULL, NULL, NULL, 'proven', NULL`,
      /study_node_conclusion_check/,
    ],
    [
      'a source without a citation',
      `'source', 'external', 'S', NULL, NULL, NULL, NULL, NULL, NULL`,
      /study_node_source_check/,
    ],
    [
      'a source citation with neither URL nor locator',
      `'source', 'external', 'S', NULL, NULL, NULL, NULL, NULL, '{"kind": "web"}'`,
      /study_node_source_check/,
    ],
    [
      'a source title over 200 characters',
      `'source', 'external', repeat('x', 201), NULL, NULL, NULL, NULL, NULL, '{"locator": "p. 1"}'`,
      /study_node_title_check/,
    ],
    [
      'a citation on a thought',
      `'thought', 'user', NULL, NULL, NULL, 'T', NULL, NULL, '{"locator": "p. 1"}'`,
      /study_node_source_check/,
    ],
  ])('refuses %s in study_node (BIB-19, BIB-25)', async (_, values, constraint) => {
    const owner = await insertUser();
    const studyId = await insertStudy(owner);
    await expect(
      db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, title, question_status,
           scripture_reference_id, body, observation_kind, conclusion_status, payload_json)
         VALUES ($1, $2, ${values})`,
        { bind: [studyId, owner], type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow(constraint);
  });

  describe('canonical Scripture nodes (BIB-26)', () => {
    const CANONICAL_VIOLATION = { code: '23505', constraint: 'study_node_canonical_scripture_key' };

    /** Two shared reference ids (any; the corpus is imported in the test database). */
    async function references(): Promise<[string, string]> {
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM scripture_reference ORDER BY id LIMIT 2`,
        { type: QueryTypes.SELECT },
      );
      const [first, second] = rows;
      if (!first || !second) throw new Error('expected two scripture references');
      return [first.id, second.id];
    }

    /** Inserts a Scripture node (canonical unless `canonical` is given); returns its id. */
    async function insertScripture(
      studyId: string,
      ownerId: string,
      referenceId: string,
      canonical: string | null = null,
      id: string = randomUUID(),
    ): Promise<string> {
      await db.query(
        `INSERT INTO study_node
           (id, study_id, owner_id, type, origin, scripture_reference_id, canonical_node_id)
         VALUES ($1, $2, $3, 'scripture', 'scripture', $4, $5)`,
        { bind: [id, studyId, ownerId, referenceId, canonical], type: QueryTypes.INSERT },
      );
      return id;
    }

    it('allows one live canonical node per study and reference; a deleted one does not count, and other references and studies are independent', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const otherStudyId = await insertStudy(owner);
      const [romans, other] = await references();
      const first = await insertScripture(studyId, owner, romans);
      await expect(insertScripture(studyId, owner, romans)).rejects.toMatchObject({
        parent: expect.objectContaining(CANONICAL_VIOLATION),
      });
      await insertScripture(studyId, owner, other);
      await insertScripture(otherStudyId, owner, romans);
      await db.query(`UPDATE study_node SET deleted_at = now() WHERE id = $1`, { bind: [first] });
      await expect(insertScripture(studyId, owner, romans)).resolves.toEqual(expect.any(String));
    });

    it('refuses a second live canonical node from a concurrent transaction once the first commits', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const [romans] = await references();
      const insert = `INSERT INTO study_node (study_id, owner_id, type, origin, scripture_reference_id)
                      VALUES ($1, $2, 'scripture', 'scripture', $3)`;
      const first = await db.transaction();
      const second = await db.transaction();
      try {
        await db.query(insert, { bind: [studyId, owner, romans], transaction: first });
        // The second insert waits on the first's uncommitted index entry, then fails on COMMIT.
        const racing = db
          .query(insert, { bind: [studyId, owner, romans], transaction: second })
          .then(
            () => 'inserted',
            (error: unknown) => error,
          );
        await first.commit();
        expect(await racing).toMatchObject({
          parent: expect.objectContaining(CANONICAL_VIOLATION),
        });
      } finally {
        await second.rollback();
      }
      const [row] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM study_node WHERE study_id = $1`,
        { bind: [studyId], type: QueryTypes.SELECT },
      );
      expect(row?.n).toBe(1);
    });

    it('lets a duplicate name only a Scripture node of its own study, owner and reference, never itself; no other type can be a duplicate', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const otherStudyId = await insertStudy(owner);
      const [romans, other] = await references();
      const canonical = await insertScripture(studyId, owner, romans);
      const otherReference = await insertScripture(studyId, owner, other);
      const otherStudy = await insertScripture(otherStudyId, owner, romans);
      const question = await insertNode(studyId, owner);
      for (const target of [otherReference, otherStudy, question, randomUUID()]) {
        await expect(insertScripture(studyId, owner, romans, target)).rejects.toThrow(
          /study_node_canonical_node_fk/,
        );
      }
      const self = randomUUID();
      await expect(insertScripture(studyId, owner, romans, self, self)).rejects.toThrow(
        /study_node_canonical_check/,
      );
      await expect(
        db.query(
          `INSERT INTO study_node (study_id, owner_id, type, origin, body, canonical_node_id)
           VALUES ($1, $2, 'thought', 'user', 'T', $3)`,
          { bind: [studyId, owner, canonical], type: QueryTypes.INSERT },
        ),
      ).rejects.toThrow(/study_node_canonical_check/);
      // Several duplicates of one canonical node are fine, live or deleted.
      await insertScripture(studyId, owner, romans, canonical);
      await insertScripture(studyId, owner, romans, canonical);
      await expect(
        db.query(`DELETE FROM study_node WHERE id = $1`, { bind: [canonical] }),
      ).rejects.toThrow(/study_node_canonical_node_fk/);
    });

    const CHAIN_VIOLATION = {
      code: '23000',
      message: 'a duplicate study node must name a canonical node',
    };

    it('refuses a duplicate of a duplicate, and a node that duplicates name becoming a duplicate', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const [romans] = await references();
      const canonical = await insertScripture(studyId, owner, romans);
      const duplicate = await insertScripture(studyId, owner, romans, canonical);
      // Forward: a new row naming a duplicate.
      await expect(insertScripture(studyId, owner, romans, duplicate)).rejects.toMatchObject({
        parent: expect.objectContaining(CHAIN_VIOLATION),
      });
      // Forward via UPDATE: an existing canonical-less row re-pointed at a duplicate.
      const second = await insertScripture(studyId, owner, romans, canonical);
      await expect(
        db.query(`UPDATE study_node SET canonical_node_id = $1 WHERE id = $2`, {
          bind: [duplicate, second],
        }),
      ).rejects.toMatchObject({ parent: expect.objectContaining(CHAIN_VIOLATION) });
      // Reverse: once `canonical` is deleted and a new canonical node exists, `canonical` (which
      // duplicates still name) cannot itself become a duplicate of the new one.
      await db.query(`UPDATE study_node SET deleted_at = now() WHERE id = $1`, {
        bind: [canonical],
      });
      const replacement = await insertScripture(studyId, owner, romans);
      await expect(
        db.query(`UPDATE study_node SET canonical_node_id = $1 WHERE id = $2`, {
          bind: [replacement, canonical],
        }),
      ).rejects.toMatchObject({ parent: expect.objectContaining(CHAIN_VIOLATION) });
      // A duplicate may still be re-pointed at a canonical node.
      await db.query(`UPDATE study_node SET canonical_node_id = $1 WHERE id = $2`, {
        bind: [replacement, second],
      });
      const rows = await db.query<{ id: string }>(
        `SELECT d.id FROM study_node d JOIN study_node t ON t.id = d.canonical_node_id
          WHERE d.study_id = $1 AND t.canonical_node_id IS NOT NULL`,
        { bind: [studyId], type: QueryTypes.SELECT },
      );
      expect(rows).toStrictEqual([]);
    });

    it('serializes a node becoming a duplicate against a concurrent duplicate naming it', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const [romans] = await references();
      const target = await insertScripture(studyId, owner, romans);
      await db.query(`UPDATE study_node SET deleted_at = now() WHERE id = $1`, { bind: [target] });
      const replacement = await insertScripture(studyId, owner, romans);
      const first = await db.transaction();
      const second = await db.transaction();
      try {
        await db.query(`UPDATE study_node SET canonical_node_id = $1 WHERE id = $2`, {
          bind: [replacement, target],
          transaction: first,
        });
        // The second insert's trigger waits on the first's row lock, then sees `target` is now a
        // duplicate.
        const racing = insertScriptureIn(second, studyId, owner, romans, target).then(
          () => 'inserted',
          (error: unknown) => error,
        );
        await first.commit();
        expect(await racing).toMatchObject({ parent: expect.objectContaining(CHAIN_VIOLATION) });
      } finally {
        await second.rollback();
      }
    });

    async function insertScriptureIn(
      transaction: Awaited<ReturnType<typeof db.transaction>>,
      studyId: string,
      ownerId: string,
      referenceId: string,
      canonical: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO study_node
           (study_id, owner_id, type, origin, scripture_reference_id, canonical_node_id)
         VALUES ($1, $2, 'scripture', 'scripture', $3, $4)`,
        { bind: [studyId, ownerId, referenceId, canonical], type: QueryTypes.INSERT, transaction },
      );
    }

    it('purges a study holding a canonical node and its duplicates in one statement', async () => {
      const owner = await insertUser();
      const studyId = await insertStudy(owner);
      const [romans] = await references();
      const canonical = await insertScripture(studyId, owner, romans);
      await insertScripture(studyId, owner, romans, canonical);
      await insertScripture(studyId, owner, romans, canonical);
      await db.query(`DELETE FROM study WHERE id = $1`, { bind: [studyId] });
      const [row] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM study_node WHERE study_id = $1`,
        { bind: [studyId], type: QueryTypes.SELECT },
      );
      expect(row?.n).toBe(0);
    });
  });
});
