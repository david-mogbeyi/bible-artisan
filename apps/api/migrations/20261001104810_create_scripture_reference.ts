import type { MigrationContext } from '../src/database/migrator';

// `scripture_reference` (BIB-15, PRD §23 ScriptureReference): one canonical, contiguous range
// within one book of one edition, so the reader (BIB-17), study creation (BIB-19) and Scripture
// nodes (BIB-25/26) can all point at the same stable id. Shared, not private: it carries no user
// content, so it has no owner columns.
// - Edition-bound (FR-BIBLE-007): there is no canon/versification table yet, and each edition
//   defines its own versification, so `edition_id` stands in for PRD's canon/versification pair.
// - Both endpoints are composite FKs to `bible_verse`'s primary key, so a range can only be
//   written between verses that exist in the imported corpus, and one `book_code` makes a
//   cross-book range unwritable.
// - The CHECK keeps start <= end; the UNIQUE constraint is the canonical identity (the resolver
//   inserts with ON CONFLICT DO NOTHING, reading the existing row back in the same statement).
// - Rows are never updated, deleted or truncated: other tables will reference these ids, and
//   removing one and re-inserting its range would mint a new id (or re-point an old one), silently
//   changing what every referencing study shows. Row triggers refuse UPDATE and DELETE; a
//   statement trigger refuses TRUNCATE. Like the BIB-14 corpus triggers, the function pins
//   `search_path = pg_catalog, pg_temp` and everything is schema-qualified, and the error is a
//   fixed, content-free SQLSTATE 23000.
// - The 200-verse limit (PRD §14) is enforced by the resolver, since it needs per-chapter counts.
//
// `down` refuses while any row exists unless ALLOW_CORPUS_DROP=1 is set in the migrator's
// environment: these ids are corpus-bound shared identity, guarded by the same opt-in as the
// corpus itself (ADR 0001, BIB-14 addendum). Each migration's `down` commits on its own, so
// without this a `down` past the corpus would drop the ids here before the corpus guard refused,
// leaving a half-reverted database. DROP TABLE fires no row or TRUNCATE triggers.

/** A plain lower-case identifier: safe to double-quote into DDL. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function referenceSchema(context: MigrationContext): Promise<string> {
  const [row] = await context.select<{ schema: string | null }>(
    'SELECT current_schema() AS schema',
  );
  if (!row?.schema || !SCHEMA_NAME.test(row.schema)) {
    throw new Error('create_scripture_reference: unsupported current schema');
  }
  return `"${row.schema}"`;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const s = await referenceSchema(context);
  await context.query(`
    CREATE TABLE ${s}.scripture_reference (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id uuid NOT NULL,
      book_code text NOT NULL,
      start_chapter smallint NOT NULL,
      start_verse smallint NOT NULL,
      end_chapter smallint NOT NULL,
      end_verse smallint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scripture_reference_start_fkey
        FOREIGN KEY (edition_id, book_code, start_chapter, start_verse)
        REFERENCES ${s}.bible_verse (edition_id, book_code, chapter, verse) ON DELETE RESTRICT,
      CONSTRAINT scripture_reference_end_fkey
        FOREIGN KEY (edition_id, book_code, end_chapter, end_verse)
        REFERENCES ${s}.bible_verse (edition_id, book_code, chapter, verse) ON DELETE RESTRICT,
      CONSTRAINT scripture_reference_order_check
        CHECK ((start_chapter, start_verse) <= (end_chapter, end_verse)),
      CONSTRAINT scripture_reference_range_key
        UNIQUE (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
    );

    CREATE FUNCTION ${s}.scripture_reference_refuse_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'scripture_reference is immutable: % is not allowed', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;

    CREATE TRIGGER scripture_reference_refuse_change
      BEFORE UPDATE OR DELETE ON ${s}.scripture_reference
      FOR EACH ROW EXECUTE FUNCTION ${s}.scripture_reference_refuse_change();
    CREATE TRIGGER scripture_reference_refuse_truncate
      BEFORE TRUNCATE ON ${s}.scripture_reference
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.scripture_reference_refuse_change();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  const s = await referenceSchema(context);
  if (process.env.ALLOW_CORPUS_DROP !== '1') {
    // Fixed, content-free refusal; the migration's transaction rolls back and nothing changes.
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ${s}.scripture_reference) THEN
          RAISE EXCEPTION 'scripture_reference drop refused: shared reference ids exist (set ALLOW_CORPUS_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    DROP TABLE IF EXISTS ${s}.scripture_reference;
    DROP FUNCTION IF EXISTS ${s}.scripture_reference_refuse_change();
  `);
}
