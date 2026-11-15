import type { MigrationContext } from '../src/database/migrator';

// BIB-33 / BIB-34: study sessions and the saved resume context (PRD sections 8, 18, 23).
//
// `study_session` ("StudySession — id; study_id; owner_id; tab_instance_id; started_at;
// last_meaningful_activity_at; ended_at; active_branch_id; last_visit_event_id. Index
// study/started_at"): one period of meaningful activity of one browser tab in one study.
// - `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE: a study purge removes them.
// - `(owner_id, study_id, last_visit_event_id) -> study_event (owner_id, study_id, id)`: the last
//   visit is an event of the same study and owner. NO ACTION: events are only deleted by the
//   study purge's cascade, which removes the session in the same statement.
// - `active_branch_id` is a soft reference, like `study_event.branch_id`.
// - `study_session_open_tab_key`: at most one open session per tab and study (the API resolves
//   sessions under the study row lock; this is the backstop).
// - `end_reason` inactivity | exit, set exactly when `ended_at` is.
//
// `study_view_state` gains the saved context (BIB-34): selected node, active branch, active
// question and reader passage (soft references, checked by the API on save and re-checked as live
// on resume, so a later delete falls back instead of failing), viewport and pane state (bounded
// JSON), and `context_saved_at` (when selection, branch or passage last changed; position saves
// do not move it).
//
// `down` refuses while any study exists (sessions and saved context are study data) unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study_session (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      tab_instance_id uuid NOT NULL,
      started_at timestamptz NOT NULL,
      last_meaningful_activity_at timestamptz NOT NULL,
      ended_at timestamptz,
      end_reason text,
      active_branch_id uuid,
      last_visit_event_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_session_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_session_last_visit_fk
        FOREIGN KEY (owner_id, study_id, last_visit_event_id)
        REFERENCES study_event (owner_id, study_id, id),
      CONSTRAINT study_session_end_reason_check
        CHECK (end_reason IN ('inactivity', 'exit')),
      CONSTRAINT study_session_ended_check
        CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
      CONSTRAINT study_session_times_check
        CHECK (last_meaningful_activity_at >= started_at
               AND (ended_at IS NULL OR ended_at >= started_at))
    );
  `);
  await context.query(`
    CREATE INDEX study_session_study_started_idx ON study_session (study_id, started_at);
    CREATE INDEX study_session_owner_study_idx ON study_session (owner_id, study_id);
    CREATE INDEX study_session_last_visit_idx
      ON study_session (owner_id, study_id, last_visit_event_id)
      WHERE last_visit_event_id IS NOT NULL;
    CREATE UNIQUE INDEX study_session_open_tab_key
      ON study_session (owner_id, study_id, tab_instance_id) WHERE ended_at IS NULL;
  `);
  await context.query(`
    ALTER TABLE study_view_state
      ADD COLUMN selected_node_id uuid,
      ADD COLUMN active_branch_id uuid,
      ADD COLUMN active_question_node_id uuid,
      ADD COLUMN reader_reference_id uuid,
      ADD COLUMN viewport jsonb,
      ADD COLUMN pane_state jsonb,
      ADD COLUMN context_saved_at timestamptz,
      ADD CONSTRAINT study_view_state_viewport_check
        CHECK (viewport IS NULL OR jsonb_typeof(viewport) = 'object'),
      ADD CONSTRAINT study_view_state_pane_state_check
        CHECK (pane_state IS NULL OR jsonb_typeof(pane_state) = 'object');
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'study session drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    ALTER TABLE study_view_state
      DROP CONSTRAINT study_view_state_pane_state_check,
      DROP CONSTRAINT study_view_state_viewport_check,
      DROP COLUMN context_saved_at,
      DROP COLUMN pane_state,
      DROP COLUMN viewport,
      DROP COLUMN reader_reference_id,
      DROP COLUMN active_question_node_id,
      DROP COLUMN active_branch_id,
      DROP COLUMN selected_node_id;
  `);
  await context.query(`DROP TABLE study_session;`);
}
