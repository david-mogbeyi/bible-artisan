import type { MigrationContext } from '../src/database/migrator';

// BIB-23: rich notes and their checkpoint versions (PRD sections 15, 23; FR-NOTE-001/002/004).
//
// `note` is study-scoped: `(owner_id, study_id) -> study (owner_id, id)`, cascading, so a study
// (or user) hard delete removes its notes, and a note can never name another owner's study. An
// optional target node of the SAME study and owner: `(owner_id, study_id, target_node_id) ->
// study_node (owner_id, study_id, id)` (MATCH SIMPLE, so a study note's NULL target is not
// checked). Nodes are soft-deleted, so a deleted target keeps the note attached for orphaned-note
// review (FR-NOTE-002); the FK is NO ACTION like the other node pointers, which PostgreSQL checks
// at the end of the statement, after a study delete has cascaded both sides away.
//
// - `rich_text_json`: the allowlisted Tiptap/ProseMirror document (`noteDocumentSchema`), always
//   validated by the API before it is written; the CHECK only pins its root.
// - `plain_text`: derived by the API (`notePlainText`), at most 50,000 code points (PRD section
//   15; `char_length` counts code points, as the API does).
// - `search_text`: `noteSearchText(plain_text)`, the library's literal fold (BIB-21).
// - `latest_version_number`: the newest `note_version.version_number` ever written. Versions are
//   numbered from it, so pruning to the newest 100 never reuses a number.
// - `deleted_at`: in the note trash (reversible, PRD section 15), written with the DB clock.
//
// `note_version` holds immutable checkpoints: `(owner_id, study_id, note_id) -> note (owner_id,
// study_id, id)`, cascading, so versions go with their note and can never cross owners or
// studies. UNIQUE (note_id, version_number) also serves "newest first" listing. A trigger refuses
// every UPDATE (fixed, content-free message, SQLSTATE 23000); the API only inserts versions and
// deletes those beyond the newest 100.
//
// Indexes: (owner_id, study_id, updated_at, id) serves the note list and the library's per-study
// note search; (owner_id, study_id, target_node_id) serves the target FK's checks.
//
// `down` drops both tables. It refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1
// (ADR 0001, BIB-19 addendum), not only while notes exist: notes are user data, and each `down`
// commits on its own, so an unguarded step here would commit before BIB-22's guard refused,
// leaving a half-reverted database (the reversibility suite expects this step's refusal first).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE note (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      target_node_id uuid,
      rich_text_json jsonb NOT NULL,
      plain_text text NOT NULL,
      search_text text NOT NULL,
      schema_version smallint NOT NULL DEFAULT 1,
      revision integer NOT NULL DEFAULT 1,
      latest_version_number integer NOT NULL DEFAULT 1,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT note_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id),
      CONSTRAINT note_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT note_target_node_fk
        FOREIGN KEY (owner_id, study_id, target_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      CONSTRAINT note_rich_text_json_check
        CHECK (jsonb_typeof(rich_text_json) = 'object' AND rich_text_json ->> 'type' = 'doc'),
      CONSTRAINT note_plain_text_check CHECK (char_length(plain_text) <= 50000),
      CONSTRAINT note_schema_version_check CHECK (schema_version >= 1),
      CONSTRAINT note_revision_check CHECK (revision >= 1),
      CONSTRAINT note_latest_version_number_check CHECK (latest_version_number >= 1)
    );
  `);
  await context.query(`
    CREATE INDEX note_study_updated_idx ON note (owner_id, study_id, updated_at DESC, id DESC);
    CREATE INDEX note_target_node_idx ON note (owner_id, study_id, target_node_id)
      WHERE target_node_id IS NOT NULL;
  `);
  await context.query(`
    CREATE TABLE note_version (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      note_id uuid NOT NULL,
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      version_number integer NOT NULL,
      rich_text_json jsonb NOT NULL,
      plain_text text NOT NULL,
      schema_version smallint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT note_version_note_fk
        FOREIGN KEY (owner_id, study_id, note_id) REFERENCES note (owner_id, study_id, id)
        ON DELETE CASCADE,
      CONSTRAINT note_version_note_id_version_number_key UNIQUE (note_id, version_number),
      CONSTRAINT note_version_version_number_check CHECK (version_number >= 1),
      CONSTRAINT note_version_rich_text_json_check
        CHECK (jsonb_typeof(rich_text_json) = 'object' AND rich_text_json ->> 'type' = 'doc'),
      CONSTRAINT note_version_plain_text_check CHECK (char_length(plain_text) <= 50000),
      CONSTRAINT note_version_schema_version_check CHECK (schema_version >= 1)
    );
  `);
  await context.query(`
    CREATE FUNCTION note_version_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'note versions are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER note_version_immutable
      BEFORE UPDATE ON note_version
      FOR EACH ROW EXECUTE FUNCTION note_version_immutable();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'note drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS note_version;`);
  await context.query(`DROP FUNCTION IF EXISTS note_version_immutable();`);
  await context.query(`DROP TABLE IF EXISTS note;`);
}
