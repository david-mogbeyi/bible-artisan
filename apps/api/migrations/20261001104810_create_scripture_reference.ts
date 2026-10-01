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
//   inserts with ON CONFLICT DO NOTHING and reads the row back).
// - Rows are never updated: other tables will reference these ids, and re-pointing one at other
//   verses would silently change what every referencing study shows. A trigger refuses UPDATE.
// - The 200-verse limit (PRD §14) is enforced by the resolver, since it needs per-chapter counts.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE scripture_reference (
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
        REFERENCES bible_verse (edition_id, book_code, chapter, verse) ON DELETE RESTRICT,
      CONSTRAINT scripture_reference_end_fkey
        FOREIGN KEY (edition_id, book_code, end_chapter, end_verse)
        REFERENCES bible_verse (edition_id, book_code, chapter, verse) ON DELETE RESTRICT,
      CONSTRAINT scripture_reference_order_check
        CHECK ((start_chapter, start_verse) <= (end_chapter, end_verse)),
      CONSTRAINT scripture_reference_range_key
        UNIQUE (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
    );

    CREATE FUNCTION scripture_reference_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'scripture_reference rows are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;

    CREATE TRIGGER scripture_reference_refuse_update BEFORE UPDATE ON scripture_reference
      FOR EACH ROW EXECUTE FUNCTION scripture_reference_refuse_update();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    DROP TABLE IF EXISTS scripture_reference;
    DROP FUNCTION IF EXISTS scripture_reference_refuse_update();
  `);
}
