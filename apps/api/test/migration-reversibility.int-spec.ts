import { readdirSync } from 'node:fs';
import path from 'node:path';
import { studySearchText, studyTitleSortKey, tagKey } from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { createMigrator, MIGRATIONS_DIR, shippedMigrationNames } from '../src/database/migrator';
import {
  importCorpus,
  readCorpusArtifact,
} from '../src/modules/bible-content/corpus/corpus-importer';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { withAllDropsAllowed, withStudyDataDropAllowed } from './support/study-data-drop';

const CORPUS_MIGRATION = '20261001094438_create_bible_corpus.ts';
const SEARCH_MIGRATION = '20261001115256_add_bible_verse_search_vector.ts';
const LIBRARY_MIGRATION = '20261001182657_add_study_library.ts';
/** BIB-22's lifecycle migration; `down({ to })` reverts down to and including it. */
const LIFECYCLE_MIGRATION = '20261001194710_add_study_lifecycle.ts';
/** BIB-23's notes migration. */
const NOTE_MIGRATION = '20261001222927_create_note.ts';
/** BIB-24's highlights and note Scripture targets migration. */
const ANNOTATION_MIGRATION = '20261001235033_create_annotation.ts';
/** BIB-25's typed graph nodes migration. */
const TYPED_NODES_MIGRATION = '20261002011330_add_typed_nodes.ts';
/** BIB-26's canonical Scripture nodes migration. */
const CANONICAL_MIGRATION = '20261002021301_add_canonical_scripture_nodes.ts';
const CANONICAL_REFUSED =
  'canonical scripture nodes drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)';

const DOMAIN_TABLES = [
  'annotation',
  'auth_challenge',
  'auth_session',
  'bible_book',
  'bible_edition',
  'bible_superscription',
  'bible_verse',
  'mutation_receipt',
  'note',
  'note_version',
  'scripture_reference',
  'study',
  'study_branch',
  'study_event',
  'study_node',
  'study_tag',
  'tag',
  'user',
];

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
 * later test files in this run still see the tables, and re-imports the Bible corpus the drop
 * removed (readiness needs it). Note: dropping to zero also clears any rows earlier runs left
 * behind in the test database.
 */
describe('migration reversibility', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    // Guarantee latest is restored even if an assertion above throws mid-test.
    await createMigrator(db).up();
    await importCorpus(db, readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
    await db.close();
  });

  async function columns(tables: string[]): Promise<string[]> {
    const rows = await db.query<{ c: string }>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY 1`,
      { bind: [tables], type: QueryTypes.SELECT },
    );
    return rows.map((r) => r.c);
  }

  /** A user with one study holding everything BIB-19 creation writes. Returns the user id. */
  async function seedStudyData(): Promise<string> {
    const firstVerse = `
      SELECT v.edition_id, v.book_code, v.chapter, v.verse, v.chapter, v.verse
        FROM bible_verse v
        JOIN bible_edition e ON e.id = v.edition_id AND e.activated_at IS NOT NULL
       ORDER BY v.book_code, v.chapter, v.verse
       LIMIT 1`;
    await db.query(
      `INSERT INTO scripture_reference
         (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
       ${firstVerse}
       ON CONFLICT DO NOTHING`,
    );
    const [row] = await db.query<{ user_id: string }>(
      `WITH u AS (
         INSERT INTO "user" (normalized_email) VALUES (gen_random_uuid() || '@example.test')
         RETURNING id
       ), s AS (
         INSERT INTO study (owner_id, title, starting_reference_id)
         SELECT u.id, 'Seeded', r.id
           FROM u, scripture_reference r
          WHERE (r.edition_id, r.book_code, r.start_chapter, r.start_verse, r.end_chapter, r.end_verse)
                = (${firstVerse})
         RETURNING id, owner_id, starting_reference_id
       ), q AS (
         INSERT INTO study_node (study_id, owner_id, type, origin, title, question_status)
         SELECT s.id, s.owner_id, 'question', 'user', 'Seeded question', 'open' FROM s
         RETURNING id, study_id, owner_id
       ), p AS (
         INSERT INTO study_node (study_id, owner_id, type, origin, scripture_reference_id)
         SELECT s.id, s.owner_id, 'scripture', 'scripture', s.starting_reference_id FROM s
       ), b AS (
         INSERT INTO study_branch (study_id, owner_id, root_node_id)
         SELECT q.study_id, q.owner_id, q.id FROM q
       )
       SELECT id AS user_id FROM u`,
      { type: QueryTypes.SELECT },
    );
    if (!row) throw new Error('seed returned nothing');
    await db.query(
      `UPDATE study s SET original_question_node_id = n.id, main_question_node_id = n.id
         FROM study_node n
        WHERE n.study_id = s.id AND n.type = 'question' AND s.owner_id = $1`,
      { bind: [row.user_id] },
    );
    // What BIB-20 editing writes: a pin, a description, and a tag on the study.
    await db.query(
      `WITH t AS (
         INSERT INTO tag (owner_id, name, normalized_name) VALUES ($1, 'Seeded', 'seeded')
         RETURNING id, owner_id
       ), s AS (
         UPDATE study SET pinned_at = now(), description = 'Seeded description'
          WHERE owner_id = $1 RETURNING id, owner_id
       )
       INSERT INTO study_tag (study_id, owner_id, tag_id)
       SELECT s.id, s.owner_id, t.id FROM s, t`,
      { bind: [row.user_id] },
    );
    return row.user_id;
  }

  it('refuses each study and user table drop without the study-data opt-in while rows exist', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    // Past the corpus with only the corpus opt-in fails at BIB-19 already; with both, down to just
    // after the BIB-9 tables. Their own guards are then checked one by one below.
    try {
      await withAllDropsAllowed(() =>
        migrator.down({ to: '20261001000001_create_auth_challenge.ts' }),
      );
      for (const [migration, message] of [
        ['20260930200004_create_study_event.ts', 'study_event drop refused: study events exist'],
        ['20260930200003_create_study_node.ts', 'study_node drop refused: study nodes exist'],
        ['20260930200002_create_study.ts', 'study drop refused: studies exist'],
        ['20260930200001_create_user.ts', 'user drop refused: users exist'],
      ] as const) {
        if (migration === '20260930200004_create_study_event.ts') {
          await db.query(
            `INSERT INTO study_event (study_id, owner_id, sequence, event_type)
             SELECT id, owner_id, 1, 'seeded' FROM study WHERE owner_id = $1`,
            { bind: [userId] },
          );
        }
        const before = await recordedMigrations(db);
        expect(before.at(-1)).toBe(migration);
        const error = await migrator.down().catch((e: unknown) => e);
        expect((error as { cause?: unknown }).cause).toMatchObject({
          message: `${message} (set ALLOW_STUDY_DATA_DROP=1)`,
          parent: expect.objectContaining({ code: '23000' }),
        });
        expect(await recordedMigrations(db)).toStrictEqual(before);
        await withStudyDataDropAllowed(() => migrator.down());
      }
      expect(await recordedMigrations(db)).toStrictEqual([]);
    } finally {
      await migrator.up();
      await importCorpus(db, readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
    }
  });

  it('refuses at the first destructive step from latest toward the corpus while study data exists, changing nothing', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const studyData = async (): Promise<unknown[]> =>
      db.query(
        `SELECT s.title, s.starting_reference_id, s.original_question_node_id,
                s.main_question_node_id, s.pinned_at, s.description, n.type,
                n.title AS node_title, n.question_status, n.scripture_reference_id,
                b.root_node_id, t.name AS tag_name
           FROM study s
           JOIN study_node n ON n.study_id = s.id
           JOIN study_branch b ON b.study_id = s.id
           JOIN study_tag st ON st.study_id = s.id
           JOIN tag t ON t.id = st.tag_id
          WHERE s.owner_id = $1
          ORDER BY n.type`,
        { bind: [userId], type: QueryTypes.SELECT },
      );
    try {
      const before = await recordedMigrations(db);
      expect(before).toStrictEqual(shippedMigrationNames());
      const tablesBefore = await publicTables(db, DOMAIN_TABLES);
      const columnsBefore = await columns([
        'study',
        'study_node',
        'study_branch',
        'tag',
        'study_tag',
      ]);
      const dataBefore = await studyData();
      expect(dataBefore).toHaveLength(2);

      // No opt-in at all: the newest migration (BIB-26's canonical Scripture nodes) is the first
      // `down` toward the corpus and refuses before anything commits.
      const error = await migrator.down({ to: CORPUS_MIGRATION }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: unknown }).cause).toMatchObject({
        message: CANONICAL_REFUSED,
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);
      expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(tablesBefore);
      expect(
        await columns(['study', 'study_node', 'study_branch', 'tag', 'study_tag']),
      ).toStrictEqual(columnsBefore);
      expect(await studyData()).toStrictEqual(dataBefore);
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('reverts and re-applies the study lifecycle (BIB-22): states survive, dates are backfilled, and the constraint, trigger and purge index come back', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const lifecycles = async () =>
      db.query<{ lifecycle: string; archived: boolean; deleted: boolean }>(
        `SELECT lifecycle, archived_at = updated_at AS archived, deleted_at = updated_at AS deleted
           FROM study WHERE owner_id = $1 ORDER BY lifecycle`,
        { bind: [userId], type: QueryTypes.SELECT },
      );
    try {
      // One archived and one trashed study (the seed has an active one).
      await db.query(
        `INSERT INTO study (owner_id, title, lifecycle, archived_at)
         VALUES ($1, 'Archived', 'archived', now())`,
        { bind: [userId] },
      );
      await db.query(
        `INSERT INTO study (owner_id, title, lifecycle, deleted_at)
         VALUES ($1, 'Trashed', 'trashed', now())`,
        { bind: [userId] },
      );
      const purgeIndex = async () =>
        db.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'study_trash_purge_idx'`,
          { type: QueryTypes.SELECT },
        );
      await withStudyDataDropAllowed(() => migrator.down({ to: LIFECYCLE_MIGRATION }));
      expect(await columns(['study'])).not.toContain('study.archived_at');
      expect(await purgeIndex()).toStrictEqual([]);
      await migrator.up();
      expect(await purgeIndex()).toStrictEqual([
        {
          indexdef:
            "CREATE INDEX study_trash_purge_idx ON public.study USING btree (deleted_at, id) WHERE (lifecycle = 'trashed'::text)",
        },
      ]);
      expect(await lifecycles()).toStrictEqual([
        { lifecycle: 'active', archived: null, deleted: null },
        { lifecycle: 'archived', archived: true, deleted: null },
        { lifecycle: 'trashed', archived: null, deleted: true },
      ]);
      const refused = await db
        .query(
          `UPDATE study SET lifecycle = 'active', deleted_at = NULL WHERE owner_id = $1 AND lifecycle = 'archived'`,
          {
            bind: [userId],
          },
        )
        .catch((e: unknown) => e);
      expect(refused).toMatchObject({ parent: expect.objectContaining({ code: '23514' }) });
      const transition = await db
        .query(
          `UPDATE study SET lifecycle = 'archived', archived_at = now(), deleted_at = NULL
            WHERE owner_id = $1 AND lifecycle = 'trashed'`,
          { bind: [userId] },
        )
        .catch((e: unknown) => e);
      expect(transition).toMatchObject({
        message: 'study lifecycle transition refused',
        parent: expect.objectContaining({ code: '23000' }),
      });
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('reverts and re-applies canonical Scripture nodes (BIB-26) only with the study-data opt-in; up labels later same-reference rows duplicates of the oldest, deleting nothing', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const schema = async () =>
      db.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid = 'study_node'::regclass AND conname LIKE '%canonical%'
             OR conname = 'study_node_owner_id_study_id_id_scripture_reference_id_key'
         UNION ALL
         SELECT indexname FROM pg_indexes WHERE indexname LIKE 'study_node_canonical%'
          ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
    const scriptureRows = async () =>
      db.query<{ id: string; canonical_node_id: string | null }>(
        `SELECT id, canonical_node_id FROM study_node WHERE owner_id = $1 AND type = 'scripture'
          ORDER BY created_at, id`,
        { bind: [userId], type: QueryTypes.SELECT },
      );
    try {
      const schemaBefore = await schema();
      expect(schemaBefore.map((row) => row.name)).toStrictEqual([
        'study_node_canonical_check',
        'study_node_canonical_node_fk',
        'study_node_canonical_node_idx',
        'study_node_canonical_scripture_key',
        'study_node_owner_id_study_id_id_scripture_reference_id_key',
      ]);
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(CANONICAL_MIGRATION);
      const refused = await migrator.down().catch((e: unknown) => e);
      expect((refused as { cause?: unknown }).cause).toMatchObject({
        message: CANONICAL_REFUSED,
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);

      await withStudyDataDropAllowed(() => migrator.down());
      expect((await columns(['study_node'])).filter((c) => c.includes('canonical'))).toStrictEqual(
        [],
      );
      // Rows written by hand before BIB-26: two more live copies of the seeded passage (later),
      // and a deleted one, which stays as it is.
      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, scripture_reference_id,
                                 created_at, deleted_at)
         SELECT study_id, owner_id, 'scripture', 'scripture', scripture_reference_id,
                now() + make_interval(mins => g), CASE WHEN g = 3 THEN now() END
           FROM study_node, generate_series(1, 3) g
          WHERE owner_id = $1 AND type = 'scripture'`,
        { bind: [userId] },
      );
      const untouched = async () =>
        db.query(
          `SELECT id, revision, updated_at, deleted_at FROM study_node
            WHERE owner_id = $1 ORDER BY created_at, id`,
          { bind: [userId], type: QueryTypes.SELECT },
        );
      const rowsBefore = await untouched();
      await migrator.up();
      expect(await untouched()).toStrictEqual(rowsBefore);
      const [oldest, second, third, deleted] = await scriptureRows();
      expect([
        oldest?.canonical_node_id,
        second?.canonical_node_id,
        third?.canonical_node_id,
        deleted?.canonical_node_id,
      ]).toStrictEqual([null, oldest?.id, oldest?.id, null]);
      expect(await schema()).toStrictEqual(schemaBefore);
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('reverts and re-applies typed nodes (BIB-25) only with the study-data opt-in; the columns, constraints and identity trigger come back', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const nodeSchema = async () =>
      db.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid = 'study_node'::regclass AND contype = 'c'
         UNION ALL
         SELECT tgname FROM pg_trigger WHERE tgname = 'study_node_identity_immutable'
          ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
    const nodes = async () =>
      db.query(
        `SELECT type, title, question_status, scripture_reference_id IS NOT NULL AS has_reference
           FROM study_node WHERE owner_id = $1 ORDER BY type`,
        { bind: [userId], type: QueryTypes.SELECT },
      );
    try {
      // One node of each new type, and a note attached to the thought.
      await db.query(
        `WITH s AS (SELECT id, owner_id FROM study WHERE owner_id = $1),
              t AS (
                INSERT INTO study_node (study_id, owner_id, type, origin, body)
                SELECT id, owner_id, 'thought', 'user', 'Seeded thought' FROM s
                RETURNING id, study_id, owner_id
              ),
              o AS (
                INSERT INTO study_node (study_id, owner_id, type, origin, body, observation_kind)
                SELECT id, owner_id, 'observation', 'user', 'Seeded', 'interpretation' FROM s
              ),
              c AS (
                INSERT INTO study_node (study_id, owner_id, type, origin, title, conclusion_status)
                SELECT id, owner_id, 'conclusion', 'user', 'Seeded', 'tentative' FROM s
              ),
              src AS (
                INSERT INTO study_node (study_id, owner_id, type, origin, title, payload_json)
                SELECT id, owner_id, 'source', 'external', 'Seeded', '{"kind":"book","locator":"p. 1"}'
                  FROM s
              )
         INSERT INTO note (study_id, owner_id, target_node_id, rich_text_json, plain_text, search_text)
         SELECT study_id, owner_id, id, '{"type":"doc","content":[{"type":"paragraph"}]}', '', ''
           FROM t`,
        { bind: [userId] },
      );
      const schemaBefore = await nodeSchema();
      expect(schemaBefore.map((row) => row.name)).toStrictEqual([
        'study_node_body_check',
        'study_node_canonical_check',
        'study_node_conclusion_check',
        'study_node_identity_immutable',
        'study_node_observation_check',
        'study_node_origin_check',
        'study_node_question_check',
        'study_node_scripture_check',
        'study_node_source_check',
        'study_node_title_check',
        'study_node_type_check',
      ]);
      // Past BIB-26's step (which refuses first, from latest), typed nodes' own guard refuses.
      await withStudyDataDropAllowed(() => migrator.down({ to: CANONICAL_MIGRATION }));
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(TYPED_NODES_MIGRATION);
      const nodesBefore = await nodes();
      const refused = await migrator.down().catch((e: unknown) => e);
      expect((refused as { cause?: unknown }).cause).toMatchObject({
        message: 'typed nodes drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect([await recordedMigrations(db), await nodes()]).toStrictEqual([before, nodesBefore]);

      await withStudyDataDropAllowed(() => migrator.down());
      expect(
        (await columns(['study_node'])).filter((name) =>
          /origin|body|observation_kind|conclusion_status|payload_json/.test(name),
        ),
      ).toStrictEqual([]);
      // The new types' rows went with their content; the note stays, on the study.
      expect(await nodes()).toStrictEqual([
        {
          type: 'question',
          title: 'Seeded question',
          question_status: 'open',
          has_reference: false,
        },
        { type: 'scripture', title: null, question_status: null, has_reference: true },
      ]);
      expect(
        await db.query(`SELECT target_node_id FROM note WHERE owner_id = $1`, {
          bind: [userId],
          type: QueryTypes.SELECT,
        }),
      ).toStrictEqual([{ target_node_id: null }]);

      await migrator.up();
      expect(await nodeSchema()).toStrictEqual(schemaBefore);
      expect(
        await db.query(`SELECT type, origin FROM study_node WHERE owner_id = $1 ORDER BY type`, {
          bind: [userId],
          type: QueryTypes.SELECT,
        }),
      ).toStrictEqual([
        { type: 'question', origin: 'user' },
        { type: 'scripture', origin: 'scripture' },
      ]);
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('reverts and re-applies highlights and note Scripture targets (BIB-24) only with the study-data opt-in; the table, columns and constraints come back', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const schema = async () =>
      db.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid IN ('annotation'::regclass, 'note'::regclass)
            AND (conrelid = 'annotation'::regclass OR conname LIKE 'note_%target%')
         UNION ALL
         SELECT indexname FROM pg_indexes
          WHERE indexname IN ('annotation_chapter_idx', 'annotation_study_idx')
          ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
    try {
      await db.query(
        `INSERT INTO annotation (study_id, owner_id, reference_id, edition_id, book_code,
                                 start_chapter, end_chapter, anchor_json, color_token)
         SELECT s.id, s.owner_id, r.id, r.edition_id, r.book_code, r.start_chapter,
                r.end_chapter, '{"version":1}', 'yellow'
           FROM study s, (SELECT * FROM scripture_reference LIMIT 1) r
          WHERE s.owner_id = $1`,
        { bind: [userId] },
      );
      const schemaBefore = await schema();
      expect(schemaBefore.map((row) => row.name)).toStrictEqual([
        'annotation_anchor_json_check',
        'annotation_chapter_idx',
        'annotation_chapters_check',
        'annotation_color_token_check',
        'annotation_label_check',
        'annotation_pkey',
        'annotation_reference_id_fkey',
        'annotation_revision_check',
        'annotation_study_idx',
        'annotation_study_owner_fk',
        'note_scripture_target_check',
        'note_target_node_fk',
        'note_target_reference_id_fkey',
      ]);
      // Past BIB-25's step (which refuses first, from latest), the highlights' own guard refuses.
      await withStudyDataDropAllowed(() => migrator.down({ to: TYPED_NODES_MIGRATION }));
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(ANNOTATION_MIGRATION);
      const refused = await migrator.down().catch((e: unknown) => e);
      expect((refused as { cause?: unknown }).cause).toMatchObject({
        message: 'annotation drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);
      expect(await db.query('SELECT 1 FROM annotation', { type: QueryTypes.SELECT })).toHaveLength(
        1,
      );

      await withStudyDataDropAllowed(() => migrator.down());
      expect(await publicTables(db, ['annotation'])).toStrictEqual([]);
      expect(
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'note' AND column_name LIKE 'target_%' ORDER BY column_name`,
          { type: QueryTypes.SELECT },
        ),
      ).toStrictEqual([{ column_name: 'target_node_id' }]);
      await migrator.up();
      expect(await schema()).toStrictEqual(schemaBefore);
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('reverts and re-applies notes (BIB-23) only with the study-data opt-in; the tables, keys and version trigger come back', async () => {
    const userId = await seedStudyData();
    const migrator = createMigrator(db);
    const noteSchema = async () =>
      db.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid IN ('note'::regclass, 'note_version'::regclass) AND contype IN ('f', 'u')
         UNION ALL
         SELECT tgname FROM pg_trigger WHERE tgname = 'note_version_immutable'
          ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
    try {
      await db.query(
        `WITH n AS (
           INSERT INTO note (study_id, owner_id, rich_text_json, plain_text, search_text)
           SELECT id, owner_id, '{"type":"doc","content":[{"type":"paragraph"}]}', '', ''
             FROM study WHERE owner_id = $1
           RETURNING id, study_id, owner_id
         )
         INSERT INTO note_version (note_id, study_id, owner_id, version_number, rich_text_json, plain_text)
         SELECT id, study_id, owner_id, 1, '{"type":"doc","content":[{"type":"paragraph"}]}', '' FROM n`,
        { bind: [userId] },
      );
      const schemaBefore = await noteSchema();
      expect(schemaBefore.map((row) => row.name)).toStrictEqual([
        'note_owner_id_study_id_id_key',
        'note_study_owner_fk',
        'note_target_node_fk',
        'note_target_reference_id_fkey',
        'note_version_immutable',
        'note_version_note_fk',
        'note_version_note_id_version_number_key',
      ]);
      const before = await recordedMigrations(db);
      // Past BIB-26's, BIB-25's and BIB-24's steps (which refuse first, from latest), note's own
      // guard refuses too.
      await withStudyDataDropAllowed(() => migrator.down({ to: ANNOTATION_MIGRATION }));
      const refused = await migrator.down().catch((e: unknown) => e);
      expect((refused as { cause?: unknown }).cause).toMatchObject({
        message: 'note drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(
        before.filter(
          (name) =>
            name !== ANNOTATION_MIGRATION &&
            name !== TYPED_NODES_MIGRATION &&
            name !== CANONICAL_MIGRATION,
        ),
      );
      expect(
        await db.query('SELECT 1 FROM note_version', { type: QueryTypes.SELECT }),
      ).not.toHaveLength(0);

      await withStudyDataDropAllowed(() => migrator.down({ to: NOTE_MIGRATION }));
      expect(await publicTables(db, ['note', 'note_version'])).toStrictEqual([]);
      await migrator.up();
      expect(await noteSchema()).toStrictEqual(schemaBefore);
    } finally {
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [userId] });
      await migrator.up();
    }
  });

  it('refuses to drop an active Bible corpus without the explicit opt-in, changing nothing', async () => {
    // A shared reference id exists (rows are never deleted, so a real database keeps them).
    await db.query(
      `INSERT INTO scripture_reference
         (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
       SELECT v.edition_id, v.book_code, v.chapter, v.verse, v.chapter, v.verse
         FROM bible_verse v
         JOIN bible_edition e ON e.id = v.edition_id AND e.activated_at IS NOT NULL
        ORDER BY v.book_code, v.chapter, v.verse
        LIMIT 1
       ON CONFLICT DO NOTHING`,
    );
    const references = async (): Promise<string[]> =>
      (
        await db.query<{ id: string }>(`SELECT id FROM scripture_reference ORDER BY id`, {
          type: QueryTypes.SELECT,
        })
      ).map((row) => row.id);
    const referencesBefore = await references();
    expect(referencesBefore.length).toBeGreaterThan(0);
    const migrator = createMigrator(db);
    // Migrations after the search index are not corpus-bound (BIB-19's study roots): revert them
    // with only the study-data opt-in, so the next `down` is the first corpus-bound one.
    const later = shippedMigrationNames().filter((name) => name > SEARCH_MIGRATION);
    if (later[0]) {
      const first = later[0];
      await withStudyDataDropAllowed(() => migrator.down({ to: first }));
    }
    // Restore latest even when an assertion fails, so later tests and files see the full schema.
    try {
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(SEARCH_MIGRATION);
      const tablesBefore = await publicTables(db, DOMAIN_TABLES);

      // Every migration's `down` commits on its own, so the first corpus-bound one run on the way
      // to the corpus (the search index) must refuse too, or this would leave a half-reverted
      // database.
      const error = await migrator.down({ to: CORPUS_MIGRATION }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: unknown }).cause).toMatchObject({
        message:
          'bible search index drop refused: an active edition exists (set ALLOW_CORPUS_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);
      expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(tablesBefore);
      expect(await references()).toStrictEqual(referencesBefore);
      const [active] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bible_edition WHERE activated_at IS NOT NULL`,
        { type: QueryTypes.SELECT },
      );
      expect(active).toStrictEqual({ n: 1 });
    } finally {
      await migrator.up();
    }
  });

  it('refuses to drop the shared reference ids without the opt-in once the search index is gone', async () => {
    const migrator = createMigrator(db);
    const REFERENCE_MIGRATION = '20261001104810_create_scripture_reference.ts';
    await withAllDropsAllowed(() => migrator.down({ to: SEARCH_MIGRATION }));
    // Restore latest even when an assertion fails, so later tests and files see the full schema.
    try {
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(REFERENCE_MIGRATION);

      const error = await migrator.down({ to: CORPUS_MIGRATION }).catch((e: unknown) => e);
      expect((error as { cause?: unknown }).cause).toMatchObject({
        message:
          'scripture_reference drop refused: shared reference ids exist (set ALLOW_CORPUS_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);
    } finally {
      await migrator.up();
    }
  });

  it("refuses the corpus migration's own down while an edition is active, changing nothing", async () => {
    const migrator = createMigrator(db);
    // Revert only the migrations after the corpus (with the opt-in, since reference ids exist),
    // so the next `down` reaches the corpus guard itself; `afterAll` and the next test restore latest.
    const later = shippedMigrationNames().filter((name) => name > CORPUS_MIGRATION);
    if (later[0]) {
      const first = later[0];
      await withAllDropsAllowed(() => migrator.down({ to: first }));
    }
    // Restore latest even when an assertion fails, so later tests and files see the full schema.
    try {
      const before = await recordedMigrations(db);
      expect(before.at(-1)).toBe(CORPUS_MIGRATION);
      const tablesBefore = await publicTables(db, DOMAIN_TABLES);
      expect(tablesBefore).toEqual(expect.arrayContaining(['bible_edition', 'bible_verse']));

      const error = await migrator.down({ to: CORPUS_MIGRATION }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: unknown }).cause).toMatchObject({
        message: 'bible corpus drop refused: an active edition exists (set ALLOW_CORPUS_DROP=1)',
        parent: expect.objectContaining({ code: '23000' }),
      });
      expect(await recordedMigrations(db)).toStrictEqual(before);
      expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(tablesBefore);
    } finally {
      await migrator.up();
    }
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

    // Dropping the active corpus and any study data needs both explicit opt-ins (ADR 0001, BIB-14
    // and BIB-19 addenda).
    const reverted = await withAllDropsAllowed(() => migrator.down({ to: 0 }));
    let reapplied: Awaited<ReturnType<typeof migrator.up>> | undefined;
    // Restore latest even when an assertion fails, so later tests see the full schema.
    try {
      expect(reverted.map((m) => m.name)).toStrictEqual([...allNames].reverse());
      expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual([]);
      expect(await recordedMigrations(db)).toStrictEqual([]);
      expect(await migrator.pending()).toHaveLength(allNames.length);
    } finally {
      reapplied = await migrator.up();
    }
    expect(reapplied.map((m) => m.name)).toStrictEqual(allNames);
    expect(await publicTables(db, DOMAIN_TABLES)).toStrictEqual(DOMAIN_TABLES);
    expect(await recordedMigrations(db)).toStrictEqual(allNames);
    expect(await migrator.pending()).toStrictEqual([]);
  });

  it("BIB-21's up rewrites stored final sigmas to the new fold and backfills the title sort key; its down restores the word-final form", async () => {
    const migrator = createMigrator(db);
    await withStudyDataDropAllowed(() => migrator.down({ to: LIBRARY_MIGRATION }));
    try {
      // Rows as the BIB-20 fold left them: a word-final sigma is "ς", any other "σ".
      const [user] = await db.query<{ id: string }>(
        `INSERT INTO "user" (normalized_email) VALUES (gen_random_uuid() || '@example.test')
         RETURNING id`,
        { type: QueryTypes.SELECT },
      );
      if (!user) throw new Error('seed returned nothing');
      await db.query(
        `INSERT INTO tag (owner_id, name, normalized_name)
         VALUES ($1, 'Λόγος ΑΣΤΗΡ', 'λόγος αστηρ'), ($1, 'Plain', 'plain')`,
        { bind: [user.id] },
      );
      // Already-lowercase Greek and ASCII, so the SQL backfill's lower() is exact in any locale.
      const title = 'Apple  λόγος';
      await db.query(`INSERT INTO study (owner_id, title) VALUES ($1, $2)`, {
        bind: [user.id, title],
      });
      const stored = async () =>
        db.query<{ tags: string[]; titleSortKey: string; searchText: string }>(
          `SELECT array(SELECT normalized_name FROM tag WHERE owner_id = $1 ORDER BY name COLLATE "C") AS tags,
                  s.title_sort_key AS "titleSortKey", s.search_text AS "searchText"
             FROM study s WHERE s.owner_id = $1`,
          { bind: [user.id], type: QueryTypes.SELECT },
        );

      await migrator.up({ to: LIBRARY_MIGRATION });
      expect(await stored()).toStrictEqual([
        {
          tags: ['plain', tagKey('Λόγος ΑΣΤΗΡ')],
          titleSortKey: studyTitleSortKey(title),
          searchText: studySearchText(title, null),
        },
      ]);
      expect(tagKey('Λόγος ΑΣΤΗΡ')).toBe('λόγοσ αστηρ');

      await withStudyDataDropAllowed(() => migrator.down({ to: LIBRARY_MIGRATION }));
      const [tags] = await db.query<{ tags: string[] }>(
        `SELECT array(SELECT normalized_name FROM tag WHERE owner_id = $1 ORDER BY name COLLATE "C") AS tags`,
        { bind: [user.id], type: QueryTypes.SELECT },
      );
      expect(tags).toStrictEqual({ tags: ['plain', 'λόγος αστηρ'] });
      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [user.id] });
    } finally {
      await migrator.up();
    }
  });

  it('rolls a migration that fails midway back completely and does not record it', async () => {
    const before = await recordedMigrations(db);
    const failing = createMigrator(db, {
      dir: path.join(__dirname, 'fixtures/failing-migration'),
    });

    await expect(failing.up()).rejects.toThrow(/29990101000000_fails_midway/);

    // Its first statement (CREATE TABLE) was rolled back with the failing one.
    expect(await publicTables(db, ['migration_rollback_probe'])).toStrictEqual([]);
    expect(await recordedMigrations(db)).toStrictEqual(before);
  });

  it('runs a create-then-index migration on its own transaction via context.query', async () => {
    const before = await recordedMigrations(db);
    const migrator = createMigrator(db, {
      dir: path.join(__dirname, 'fixtures/create-and-index-migration'),
    });
    try {
      const applied = await migrator.up();
      expect(applied.map((m) => m.name)).toStrictEqual(['29990102000000_create_then_index.ts']);
      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'migration_index_probe'
         ORDER BY indexname`,
        { type: QueryTypes.SELECT },
      );
      expect(indexes.map((i) => i.indexname)).toStrictEqual([
        'migration_index_probe_label_idx',
        'migration_index_probe_pkey',
      ]);
      expect(await recordedMigrations(db)).toStrictEqual(
        [...before, '29990102000000_create_then_index.ts'].sort(),
      );
    } finally {
      await migrator.down({ to: 0 });
    }
    expect(await publicTables(db, ['migration_index_probe'])).toStrictEqual([]);
    expect(await recordedMigrations(db)).toStrictEqual(before);
  });

  it("runs migrations without the pool's request-sized statement_timeout", async () => {
    const [pool] = await db.query<{ statement_timeout: string }>('SHOW statement_timeout', {
      type: QueryTypes.SELECT,
    });
    expect(pool).toStrictEqual({ statement_timeout: '30s' });
    const migrator = createMigrator(db, {
      dir: path.join(__dirname, 'fixtures/statement-timeout-migration'),
    });
    try {
      await migrator.up();
      const recorded = await db.query<{ v: string }>('SELECT v FROM migration_timeout_probe', {
        type: QueryTypes.SELECT,
      });
      expect(recorded).toStrictEqual([{ v: '0' }]);
    } finally {
      await migrator.down({ to: 0 });
    }
  });

  it('refuses to revert a migration without down() and keeps its SequelizeMeta row', async () => {
    const before = await recordedMigrations(db);
    const name = '29990103000000_no_down.ts';
    const migrator = createMigrator(db, {
      dir: path.join(__dirname, 'fixtures/missing-down-migration'),
    });
    try {
      await migrator.up();
      await expect(migrator.down()).rejects.toThrow(/does not export down\(\)/);
      expect(await recordedMigrations(db)).toStrictEqual([...before, name].sort());
      expect(await publicTables(db, ['migration_no_down_probe'])).toStrictEqual([
        'migration_no_down_probe',
      ]);
    } finally {
      await db.query(`DROP TABLE IF EXISTS migration_no_down_probe`);
      await db.query(`DELETE FROM "SequelizeMeta" WHERE name = $1`, { bind: [name] });
    }
  });
});
