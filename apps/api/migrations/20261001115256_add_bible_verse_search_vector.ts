import type { MigrationContext } from '../src/database/migrator';

// Full-text search over verse text (BIB-16, PRD §14/§23 "BibleVerse ... search_vector; GIN
// search_vector").
//
// `search_vector` is a STORED GENERATED column: PostgreSQL computes it from `text` on every
// insert, and nothing can write it directly (an INSERT or UPDATE naming it is refused). It is
// therefore a pure function of the verse text the content checksum already covers. Adding it
// rewrites the table but changes no row's `text` and fires no row trigger, so the BIB-14
// immutability triggers stay in force and the edition checksum is unchanged (tests assert both).
//
// `simple` configuration: lower-casing only, no stemming and no stopwords, so the index holds the
// literal words a user can type ("all entered terms", PRD §14; no inferred expansion). The search
// service uses it only as a candidate prefilter and verifies every result against `text`, so the
// vector can never put a verse in front of the user that the stored text does not support.
//
// A stored column rather than an expression index: ranking (`ts_rank`) needs the vector of every
// matching row, and recomputing `to_tsvector` for the commonest word (23,875 verses) took about
// 230 ms against about 10 ms reading the stored vector (ADR 0001, BIB-16 addendum).
//
// `down` drops the index and the column. Both are derived from the corpus and rebuilt by `up`, so
// no data is lost. It still refuses while an active edition exists unless ALLOW_CORPUS_DROP=1 is
// set (ADR 0001, BIB-14 addendum): each migration's `down` commits on its own, so an unguarded
// step here would commit before a `down` toward the corpus is refused further on, leaving search
// half-reverted (and broken) in a database that otherwise refused the drop.

/** A plain lower-case identifier: safe to double-quote into DDL. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function corpusSchema(context: MigrationContext): Promise<string> {
  const [row] = await context.select<{ schema: string | null }>(
    'SELECT current_schema() AS schema',
  );
  if (!row?.schema || !SCHEMA_NAME.test(row.schema)) {
    throw new Error('add_bible_verse_search_vector: unsupported current schema');
  }
  return `"${row.schema}"`;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const s = await corpusSchema(context);
  await context.query(`
    ALTER TABLE ${s}.bible_verse
      ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED;
    CREATE INDEX bible_verse_search_vector_idx ON ${s}.bible_verse USING gin (search_vector);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  const s = await corpusSchema(context);
  if (process.env.ALLOW_CORPUS_DROP !== '1') {
    // Fixed, content-free refusal; the migration's transaction rolls back and nothing changes.
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ${s}.bible_edition WHERE activated_at IS NOT NULL) THEN
          RAISE EXCEPTION 'bible search index drop refused: an active edition exists (set ALLOW_CORPUS_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    DROP INDEX ${s}.bible_verse_search_vector_idx;
    ALTER TABLE ${s}.bible_verse DROP COLUMN search_vector;
  `);
}
