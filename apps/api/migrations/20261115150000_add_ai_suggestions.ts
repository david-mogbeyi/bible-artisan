import type { MigrationContext } from '../src/database/migrator';

// BIB-41 + BIB-42: AI relationship proposals (PRD sections 12, 16, 23 `AISuggestion`, 25).
//
// `ai_job.input`: the request's parameters (for `relationships`, the two node ids and the
// regenerate flag), ids and flags only. The capability CHECKs on `ai_job` and `ai_result` now
// allow `relationships`.
//
// `ai_suggestion`: one validated proposal per row, owned by the AI module. Composite FKs into
// study (cascading), into the job that produced it (cascading), and into both endpoint nodes (NO
// ACTION, like edges: nodes are only soft-deleted). Endpoints, edge type and status are columns,
// not hidden in JSON (section 23); `proposal_json` holds the rationale and evidence ids/quotes.
// `signature` hashes capability, endpoints, type and the endpoints' revisions: a rejected
// signature suppresses the same proposal until a node changes or the user regenerates
// (FR-AI-004). `revision` is the accept/reject `expectedRevision`. Decision columns are set
// together (CHECK), and `accepted_edge_id` only when accepted.
//
// `study_edge` gains `suggestion_id` (composite FK into ai_suggestion, so a suggestion of another
// study or owner is unwritable) and `accepted_by` (must be the owner). An `ai` edge has both; a
// `user` edge has neither (CHECK). At most one live-or-deleted edge per suggestion (partial
// unique): an accept retried any number of times makes one canonical edge (FR-AI-003). The
// identity trigger now also freezes both columns, so a later retype or note edit keeps the AI
// origin and adoption (FR-GRAPH-011, FR-AI-013).
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): suggestions and edge provenance are user data.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE ai_job
      ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb,
      DROP CONSTRAINT ai_job_capability_check,
      ADD CONSTRAINT ai_job_capability_check CHECK (capability IN ('summary', 'relationships'));
  `);
  await context.query(`
    ALTER TABLE ai_result
      DROP CONSTRAINT ai_result_capability_check,
      ADD CONSTRAINT ai_result_capability_check
        CHECK (capability IN ('summary', 'relationships'));
  `);
  await context.query(`
    CREATE TABLE ai_suggestion (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      job_id uuid NOT NULL,
      capability text NOT NULL,
      status text NOT NULL DEFAULT 'proposed',
      source_node_id uuid NOT NULL,
      target_node_id uuid NOT NULL,
      edge_type text NOT NULL,
      proposal_json jsonb NOT NULL,
      signature text NOT NULL,
      basis_content_revision integer NOT NULL,
      dependency_versions jsonb NOT NULL,
      model_id text NOT NULL,
      prompt_version text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz,
      decided_by uuid,
      accepted_edge_id uuid,
      PRIMARY KEY (id),
      CONSTRAINT ai_suggestion_owner_study_id_key UNIQUE (owner_id, study_id, id),
      CONSTRAINT ai_suggestion_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_suggestion_job_fk
        FOREIGN KEY (owner_id, study_id, job_id)
        REFERENCES ai_job (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_suggestion_source_node_fk
        FOREIGN KEY (owner_id, study_id, source_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      CONSTRAINT ai_suggestion_target_node_fk
        FOREIGN KEY (owner_id, study_id, target_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      CONSTRAINT ai_suggestion_capability_check CHECK (capability IN ('relationships')),
      CONSTRAINT ai_suggestion_status_check
        CHECK (status IN ('proposed', 'accepted', 'rejected', 'expired')),
      CONSTRAINT ai_suggestion_edge_type_check CHECK (edge_type IN (
        'supports', 'contradicts', 'qualifies', 'explains', 'references', 'answers',
        'raises_question', 'historical_background', 'linguistic_background', 'fulfillment',
        'quotation', 'inference_from', 'derived_from', 'parallels', 'related_to')),
      CONSTRAINT ai_suggestion_no_self_check CHECK (source_node_id <> target_node_id),
      CONSTRAINT ai_suggestion_decided_check
        CHECK ((status IN ('accepted', 'rejected')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
      CONSTRAINT ai_suggestion_decided_by_owner_check
        CHECK (decided_by IS NULL OR decided_by = owner_id),
      CONSTRAINT ai_suggestion_accepted_edge_check
        CHECK ((status = 'accepted') = (accepted_edge_id IS NOT NULL)),
      CONSTRAINT ai_suggestion_revision_check
        CHECK (revision >= 1 AND basis_content_revision >= 1)
    );
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_status_idx
      ON ai_suggestion (owner_id, study_id, status, created_at);
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_rejected_signature_idx
      ON ai_suggestion (owner_id, study_id, signature) WHERE status = 'rejected';
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_job_idx ON ai_suggestion (owner_id, study_id, job_id);
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_source_idx ON ai_suggestion (owner_id, study_id, source_node_id);
  `);
  await context.query(`
    CREATE INDEX ai_suggestion_target_idx ON ai_suggestion (owner_id, study_id, target_node_id);
  `);
  await context.query(`
    ALTER TABLE study_edge
      ADD COLUMN suggestion_id uuid,
      ADD COLUMN accepted_by uuid,
      ADD CONSTRAINT study_edge_suggestion_fk
        FOREIGN KEY (owner_id, study_id, suggestion_id)
        REFERENCES ai_suggestion (owner_id, study_id, id),
      ADD CONSTRAINT study_edge_ai_provenance_check CHECK (
        (origin = 'ai' AND suggestion_id IS NOT NULL AND accepted_by IS NOT NULL)
        OR (origin = 'user' AND suggestion_id IS NULL AND accepted_by IS NULL)),
      ADD CONSTRAINT study_edge_accepted_by_owner_check
        CHECK (accepted_by IS NULL OR accepted_by = owner_id);
  `);
  await context.query(`
    CREATE UNIQUE INDEX study_edge_suggestion_key ON study_edge (suggestion_id)
      WHERE suggestion_id IS NOT NULL;
  `);
  await context.query(`
    CREATE OR REPLACE FUNCTION study_edge_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF NEW.study_id IS DISTINCT FROM OLD.study_id
         OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
         OR NEW.source_node_id IS DISTINCT FROM OLD.source_node_id
         OR NEW.target_node_id IS DISTINCT FROM OLD.target_node_id
         OR NEW.origin IS DISTINCT FROM OLD.origin
         OR NEW.suggestion_id IS DISTINCT FROM OLD.suggestion_id
         OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by THEN
        RAISE EXCEPTION 'a study edge''s endpoints, study, owner and origin are immutable'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) OR EXISTS (SELECT 1 FROM ai_job) THEN
          RAISE EXCEPTION 'AI suggestions drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    CREATE OR REPLACE FUNCTION study_edge_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF NEW.study_id IS DISTINCT FROM OLD.study_id
         OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
         OR NEW.source_node_id IS DISTINCT FROM OLD.source_node_id
         OR NEW.target_node_id IS DISTINCT FROM OLD.target_node_id
         OR NEW.origin IS DISTINCT FROM OLD.origin THEN
        RAISE EXCEPTION 'a study edge''s endpoints, study, owner and origin are immutable'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;
  `);
  await context.query(`DROP INDEX study_edge_suggestion_key;`);
  await context.query(`
    ALTER TABLE study_edge
      DROP CONSTRAINT study_edge_accepted_by_owner_check,
      DROP CONSTRAINT study_edge_ai_provenance_check,
      DROP CONSTRAINT study_edge_suggestion_fk,
      DROP COLUMN accepted_by,
      DROP COLUMN suggestion_id;
  `);
  await context.query(`DROP TABLE ai_suggestion;`);
  // With the opt-in, any `relationships` jobs and results go too: the old CHECKs refuse them.
  await context.query(`DELETE FROM ai_job WHERE capability <> 'summary';`);
  await context.query(`
    ALTER TABLE ai_result
      DROP CONSTRAINT ai_result_capability_check,
      ADD CONSTRAINT ai_result_capability_check CHECK (capability IN ('summary'));
  `);
  await context.query(`
    ALTER TABLE ai_job
      DROP CONSTRAINT ai_job_capability_check,
      ADD CONSTRAINT ai_job_capability_check CHECK (capability IN ('summary')),
      DROP COLUMN input;
  `);
}
