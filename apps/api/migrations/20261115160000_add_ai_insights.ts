import type { MigrationContext } from '../src/database/migrator';

// BIB-43 + BIB-44 + BIB-45: the living study summary, tension / open-question / passage proposals
// (PRD sections 16, 17, 23, 25).
//
// `ai_job` and `ai_result` allow the new capabilities `tensions`, `questions` and `passages`.
//
// `study_summary`: one immutable StudySummary v1 revision per summary job (section 17: "Persist a
// new immutable StudySummary revision"). Composite FKs into study and into the job (both
// cascading); `published_current` records whether its basis was still the study's content
// revision when it was published: a summary on an older basis is kept as a historical artifact
// and never becomes current. A trigger refuses every UPDATE (immutable revisions).
//
// `study_summary_schedule`: the automatic-summary debounce state of one study (section 17: mark
// stale on significant commits, debounce 30 seconds, at most two minutes). `observed_revision` is
// the content revision the worker last saw, `summarized_revision` the basis of the latest
// summary requested, and the two timestamps the first and last change seen since.
//
// `ai_suggestion` now also holds tension (`tensions`: two claim ids and a contradicts/qualifies
// type), open-question (`questions`: no endpoints) and passage (`passages`: no endpoints, the
// corpus-verified reference in `proposal_json`) proposals. The endpoint and type columns are
// required exactly for the edge-shaped capabilities (CHECK). `accepted_node_id` (composite FK into
// study_node) names the node an accepted question or passage became; an accepted suggestion has
// exactly one of `accepted_edge_id` and `accepted_node_id`.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): summaries and proposals are user data.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE ai_job
      DROP CONSTRAINT ai_job_capability_check,
      ADD CONSTRAINT ai_job_capability_check
        CHECK (capability IN ('summary', 'relationships', 'tensions', 'questions', 'passages'));
  `);
  await context.query(`
    ALTER TABLE ai_result
      DROP CONSTRAINT ai_result_capability_check,
      ADD CONSTRAINT ai_result_capability_check
        CHECK (capability IN ('summary', 'relationships', 'tensions', 'questions', 'passages'));
  `);
  await context.query(`
    CREATE TABLE study_summary (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      job_id uuid NOT NULL,
      basis_content_revision integer NOT NULL,
      published_current boolean NOT NULL,
      summary_json jsonb NOT NULL,
      model_id text NOT NULL,
      prompt_version text NOT NULL,
      schema_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_summary_job_key UNIQUE (owner_id, study_id, job_id),
      CONSTRAINT study_summary_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_summary_job_fk
        FOREIGN KEY (owner_id, study_id, job_id)
        REFERENCES ai_job (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT study_summary_basis_check CHECK (basis_content_revision >= 1)
    );
  `);
  await context.query(`
    CREATE INDEX study_summary_study_idx
      ON study_summary (owner_id, study_id, published_current, created_at);
  `);
  await context.query(`
    CREATE FUNCTION study_summary_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'a study summary revision is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER study_summary_immutable BEFORE UPDATE ON study_summary
      FOR EACH ROW EXECUTE FUNCTION study_summary_immutable();
  `);
  await context.query(`
    CREATE TABLE study_summary_schedule (
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      observed_revision integer NOT NULL,
      summarized_revision integer NOT NULL,
      first_dirty_at timestamptz,
      last_dirty_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, study_id),
      CONSTRAINT study_summary_schedule_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_summary_schedule_dirty_check
        CHECK ((first_dirty_at IS NULL) = (last_dirty_at IS NULL)),
      CONSTRAINT study_summary_schedule_revision_check
        CHECK (observed_revision >= 1 AND summarized_revision >= 1)
    );
  `);
  await context.query(`
    ALTER TABLE ai_suggestion
      ALTER COLUMN source_node_id DROP NOT NULL,
      ALTER COLUMN target_node_id DROP NOT NULL,
      ALTER COLUMN edge_type DROP NOT NULL,
      ADD COLUMN accepted_node_id uuid,
      DROP CONSTRAINT ai_suggestion_capability_check,
      ADD CONSTRAINT ai_suggestion_capability_check
        CHECK (capability IN ('relationships', 'tensions', 'questions', 'passages')),
      ADD CONSTRAINT ai_suggestion_shape_check CHECK (
        CASE
          WHEN capability IN ('relationships', 'tensions')
            THEN source_node_id IS NOT NULL AND target_node_id IS NOT NULL AND edge_type IS NOT NULL
          ELSE source_node_id IS NULL AND target_node_id IS NULL AND edge_type IS NULL
        END),
      ADD CONSTRAINT ai_suggestion_tension_type_check
        CHECK (capability <> 'tensions' OR edge_type IN ('contradicts', 'qualifies')),
      ADD CONSTRAINT ai_suggestion_accepted_node_fk
        FOREIGN KEY (owner_id, study_id, accepted_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      DROP CONSTRAINT ai_suggestion_accepted_edge_check,
      ADD CONSTRAINT ai_suggestion_accepted_edge_check CHECK (
        CASE
          WHEN status = 'accepted' AND capability IN ('relationships', 'tensions')
            THEN accepted_edge_id IS NOT NULL AND accepted_node_id IS NULL
          WHEN status = 'accepted'
            THEN accepted_node_id IS NOT NULL AND accepted_edge_id IS NULL
          ELSE accepted_edge_id IS NULL AND accepted_node_id IS NULL
        END);
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_capability_idx
      ON ai_suggestion (owner_id, study_id, capability, status, created_at);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) OR EXISTS (SELECT 1 FROM ai_job) THEN
          RAISE EXCEPTION 'AI insights drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP INDEX ai_suggestion_capability_idx;`);
  // With the opt-in: a tension is edge-shaped, so it is kept as a relationship suggestion (an
  // accepted one's edge still names it); question and passage rows go, since the old CHECKs
  // refuse them.
  await context.query(
    `UPDATE ai_job SET capability = 'relationships' WHERE capability = 'tensions';`,
  );
  await context.query(
    `UPDATE ai_result SET capability = 'relationships' WHERE capability = 'tensions';`,
  );
  await context.query(
    `UPDATE ai_suggestion SET capability = 'relationships' WHERE capability = 'tensions';`,
  );
  await context.query(`DELETE FROM ai_job WHERE capability IN ('questions', 'passages');`);
  await context.query(`
    ALTER TABLE ai_suggestion
      DROP CONSTRAINT ai_suggestion_accepted_edge_check,
      DROP CONSTRAINT ai_suggestion_accepted_node_fk,
      DROP CONSTRAINT ai_suggestion_tension_type_check,
      DROP CONSTRAINT ai_suggestion_shape_check,
      DROP CONSTRAINT ai_suggestion_capability_check,
      DROP COLUMN accepted_node_id,
      ADD CONSTRAINT ai_suggestion_capability_check CHECK (capability IN ('relationships')),
      ADD CONSTRAINT ai_suggestion_accepted_edge_check
        CHECK ((status = 'accepted') = (accepted_edge_id IS NOT NULL)),
      ALTER COLUMN source_node_id SET NOT NULL,
      ALTER COLUMN target_node_id SET NOT NULL,
      ALTER COLUMN edge_type SET NOT NULL;
  `);
  await context.query(`DROP TABLE study_summary_schedule;`);
  await context.query(`DROP TABLE study_summary;`);
  await context.query(`DROP FUNCTION study_summary_immutable();`);
  await context.query(`
    ALTER TABLE ai_result
      DROP CONSTRAINT ai_result_capability_check,
      ADD CONSTRAINT ai_result_capability_check
        CHECK (capability IN ('summary', 'relationships'));
  `);
  await context.query(`
    ALTER TABLE ai_job
      DROP CONSTRAINT ai_job_capability_check,
      ADD CONSTRAINT ai_job_capability_check CHECK (capability IN ('summary', 'relationships'));
  `);
}
