import type { MigrationContext } from '../src/database/migrator';

// BIB-47 / BIB-48: stored export files (PRD sections 23, 24, 29; FR-EXPORT-001/002).
//
// One row per generated export: a study's or the whole account's JSON or Markdown file, stored in
// PostgreSQL (AGENTS.md rule 9: no object store until measurements justify one). Exports module
// owns the table.
//
// - `owner_id -> "user"` ON DELETE CASCADE: an account purge removes every export file with it.
// - `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE: a study export belongs to a
//   study of the same owner (unwritable otherwise), and a study purge removes its exports. An
//   account export has no study (`study_id` NULL, so the composite FK does not apply), and the
//   CHECK ties `kind` to that.
// - `expires_at`: 24 hours after creation (database clock). Reads treat an expired row as absent,
//   and the worker deletes it (`export_file_expires_at_idx`).
//
// `down` drops the table: export files are derived copies that expire within 24 hours anyway.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE export_file (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      study_id uuid,
      kind text NOT NULL,
      format text NOT NULL,
      file_name text NOT NULL,
      content_type text NOT NULL,
      body text NOT NULL,
      byte_size integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
      PRIMARY KEY (id),
      CONSTRAINT export_file_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT export_file_kind_check CHECK (
        (kind = 'study' AND study_id IS NOT NULL) OR (kind = 'account' AND study_id IS NULL)
      ),
      CONSTRAINT export_file_format_check CHECK (format IN ('json', 'markdown')),
      CONSTRAINT export_file_byte_size_check CHECK (byte_size >= 0),
      CONSTRAINT export_file_expiry_check CHECK (expires_at > created_at)
    );
  `);
  await context.query(`CREATE INDEX export_file_owner_idx ON export_file (owner_id, created_at);`);
  await context.query(`CREATE INDEX export_file_study_idx ON export_file (owner_id, study_id);`);
  await context.query(`CREATE INDEX export_file_expires_at_idx ON export_file (expires_at);`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE export_file;`);
}
