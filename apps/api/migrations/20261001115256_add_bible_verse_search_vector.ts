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
// Locale independence: the default parser classifies non-ASCII characters through LC_CTYPE, so
// under `C` a word touching a curly quote or an em dash (`lord’s`, `“behold—you`) stays one
// lexeme and the prefilter would drop the verse. The text is therefore passed through
// `translate`, which blanks every non-ASCII character in the corpus (no-break space, em dash,
// curly single and double quotation marks; none is a letter or digit) to an ASCII space first.
// ASCII is classified identically in every locale. The character list is frozen here; the app's
// copy is `SEARCH_VECTOR_BLANKED_CHARS` (search/search-vector.ts), and tests assert the live
// expression equals it and re-derive the list from the imported corpus. `up` also probes the
// expression and refuses to finish if it does not split as expected.
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

/** The corpus's non-ASCII characters, as a Unicode-escaped literal, and as many ASCII spaces. */
const BLANKED = String.raw`U&'\00A0\2014\2018\2019\201C\201D'`;
const SPACES = "'      '";

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const s = await corpusSchema(context);
  // Defense in depth: one word on each side of every blanked character must come out as its own
  // lexeme, in order, whatever this database's LC_CTYPE is. Fixed, content-free error.
  await context.query(String.raw`
    DO $$
    BEGIN
      IF to_tsvector('simple'::regconfig,
           translate(U&'a\00A0b\2014c\2018d\2019e\201Cf\201Dg', ${BLANKED}, ${SPACES}))::text
         IS DISTINCT FROM '''a'':1 ''b'':2 ''c'':3 ''d'':4 ''e'':5 ''f'':6 ''g'':7' THEN
        RAISE EXCEPTION 'search_vector probe failed: text search does not split corpus punctuation'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END
    $$;
  `);
  await context.query(`
    ALTER TABLE ${s}.bible_verse
      ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, translate(text, ${BLANKED}, ${SPACES}))) STORED;
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
