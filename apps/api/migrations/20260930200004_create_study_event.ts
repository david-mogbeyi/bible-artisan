import type { MigrationContext } from '../src/database/migrator';

// `study_event`: minimal append-only shape proving the composite-FK + per-study `sequence`
// pattern (this ticket's "Data changes"). No application code writes this table yet — the
// transactional sequence allocator and the rest of the event taxonomy are BIB-12's job. The
// composite FK to study(owner_id, id) makes an owner/study mismatch unwritable at the DB level.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.sequelize.query(`
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

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.sequelize.query(`DROP TABLE IF EXISTS study_event;`);
}
