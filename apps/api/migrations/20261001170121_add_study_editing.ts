import type { MigrationContext } from '../src/database/migrator';

// BIB-20: what editing a study writes (PRD sections 11, 15, 23; FR-STUDY-003).
//
// `study`:
// - `pinned_at`: when the owner pinned the study, NULL when unpinned. Pinned studies form their
//   own group in the library (PRD section 11; listing is BIB-21).
// - CHECKs on the user-text bounds the API already enforces: title 1–200 characters (PRD
//   section 15), description NULL or 1–2,000. `char_length` counts code points, which is never
//   more than the UTF-16 units the API counts, so every accepted value fits.
// - `study_original_question_immutable`: once `original_question_node_id` is set, no UPDATE can
//   change it (PRD section 23: "Original question is retained; changing main question does not
//   rewrite it"). Setting it from NULL stays allowed: a study created without a question gets its
//   first main question as its original. A study DELETE is not an UPDATE, so hard delete still
//   cascades.
//
// `tag` is owner-scoped (one vocabulary per user, PRD section 23 "Tag ... unique
// owner/normalized_name"). `name` is the display form (NFC, trimmed, whitespace collapsed),
// `normalized_name` its folded key (NFKC, format characters removed, case-folded, dotted/dotless
// I as "i"); both are computed by `normalizeTagName`/`tagKey` in @bible-artisan/contracts.
// UNIQUE (owner_id, id) is study_tag's composite FK target. The API deletes a tag once no study
// references it, in the transaction that removes its last pairing, so a `tag` row always has at
// least one `study_tag` (the down guard's "any tag" therefore means "any tagged study").
//
// `study_tag` pairs a study with a tag of the SAME owner: both composite FKs carry `owner_id`, so
// tagging another user's study, or using another user's tag, is unwritable. Both cascade, so a
// study or user hard delete removes its pairs. (owner_id, tag_id) serves the library tag filter
// (BIB-21) and the FK's delete check.
//
// `down` drops tags, tag pairs and pins. Descriptions stay: the column predates this migration
// and only its CHECK goes. It refuses, with a fixed content-free error and nothing changed, while
// any tag or pin exists, unless ALLOW_STUDY_DATA_DROP=1 is set in the migrator's environment
// (ADR 0001, BIB-19 addendum).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      ADD COLUMN pinned_at timestamptz,
      ADD CONSTRAINT study_title_check CHECK (char_length(title) BETWEEN 1 AND 200),
      ADD CONSTRAINT study_description_check
        CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000);
  `);
  await context.query(`
    CREATE FUNCTION study_original_question_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.original_question_node_id IS NOT NULL
         AND NEW.original_question_node_id IS DISTINCT FROM OLD.original_question_node_id THEN
        RAISE EXCEPTION 'study original question is immutable'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER study_original_question_immutable
      BEFORE UPDATE OF original_question_node_id ON study
      FOR EACH ROW EXECUTE FUNCTION study_original_question_immutable();
  `);
  await context.query(`
    CREATE TABLE tag (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      name text NOT NULL,
      normalized_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT tag_owner_id_id_key UNIQUE (owner_id, id),
      CONSTRAINT tag_owner_id_normalized_name_key UNIQUE (owner_id, normalized_name),
      CONSTRAINT tag_name_check CHECK (char_length(name) BETWEEN 1 AND 50),
      CONSTRAINT tag_normalized_name_check CHECK (char_length(normalized_name) >= 1)
    );
  `);
  await context.query(`
    CREATE TABLE study_tag (
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (study_id, tag_id),
      CONSTRAINT study_tag_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_tag_tag_owner_fk
        FOREIGN KEY (owner_id, tag_id) REFERENCES tag (owner_id, id) ON DELETE CASCADE
    );
  `);
  await context.query(
    `CREATE INDEX study_tag_owner_id_tag_id_idx ON study_tag (owner_id, tag_id);`,
  );
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    // Fixed, content-free refusal; the migration's transaction rolls back and nothing changes.
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM tag)
          OR EXISTS (SELECT 1 FROM study WHERE pinned_at IS NOT NULL)
        THEN
          RAISE EXCEPTION 'study editing drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS study_tag;`);
  await context.query(`DROP TABLE IF EXISTS tag;`);
  await context.query(`DROP TRIGGER IF EXISTS study_original_question_immutable ON study;`);
  await context.query(`DROP FUNCTION IF EXISTS study_original_question_immutable();`);
  await context.query(`
    ALTER TABLE study
      DROP CONSTRAINT IF EXISTS study_description_check,
      DROP CONSTRAINT IF EXISTS study_title_check,
      DROP COLUMN IF EXISTS pinned_at;
  `);
}
