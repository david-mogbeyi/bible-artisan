import type { MigrationContext } from '../src/database/migrator';

// `study_event`: minimal append-only shape proving the composite-FK + per-study `sequence`
// pattern (this ticket's "Data changes"). No application code writes this table yet — the
// transactional sequence allocator and the rest of the event taxonomy are BIB-12's job. The
// composite FK to study(owner_id, id) makes an owner/study mismatch unwritable at the DB level.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study_event (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      sequence bigint NOT NULL,
      event_type text NOT NULL,
      payload_json jsonb NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_event_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id),
      CONSTRAINT study_event_study_id_sequence_key UNIQUE (study_id, sequence)
    );
  `);
}

// `down` refuses while any row exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum):
// a fixed, content-free error, and the migration's transaction rolls back, changing nothing.
export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study_event) THEN
          RAISE EXCEPTION 'study_event drop refused: study events exist (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS study_event;`);
}
