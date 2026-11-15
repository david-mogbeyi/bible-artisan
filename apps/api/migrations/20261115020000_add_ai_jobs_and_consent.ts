import type { MigrationContext } from '../src/database/migrator';

// BIB-39 + BIB-40: AI consent, per-study AI switch, and leased AI jobs (PRD sections 16, 23, 25, 29).
//
// `user` gains the account AI switch (FR-AI-001, NFR-PRIV-002): `ai_enabled` is false by default
// and can only be true with a recorded consent version (CHECK). `ai_settings_revision` is the
// revision `PUT /me/ai-consent` checks.
//
// `study_ai_setting`: a study's own switch ("Study-specific disable overrides account enablement"),
// one lazily created row per study with its own revision, so toggling AI never moves the study's
// content revision (BIB-28's presentation-row pattern). Composite FK into study, cascading.
//
// `ai_job`: PostgreSQL-leased jobs (`SELECT … FOR UPDATE SKIP LOCKED`, no broker). Composite FK
// into study (owner can never mismatch), UNIQUE (owner_id, request_key) for idempotent requests,
// UNIQUE (owner_id, study_id, id) for the children's composite FKs. Partial indexes serve the
// claim query: queued by `available_at`, running by expired `lease_until`.
//
// `context_manifest` and `ai_result`: one each per job at most (UNIQUE job), owner/study bound to
// the job by composite FK. Manifests hold ids, kinds, versions and token counts, never text;
// results hold the validated output inside the owner's scope.
//
// `down` refuses while any study, AI job or recorded consent exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): results and consent records are user data.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE "user"
      ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN ai_consent_version text,
      ADD COLUMN ai_consented_at timestamptz,
      ADD COLUMN ai_settings_revision integer NOT NULL DEFAULT 1,
      ADD CONSTRAINT user_ai_enabled_needs_consent_check
        CHECK (NOT ai_enabled OR (ai_consent_version IS NOT NULL AND ai_consented_at IS NOT NULL)),
      ADD CONSTRAINT user_ai_settings_revision_check CHECK (ai_settings_revision >= 1);
  `);
  await context.query(`
    CREATE TABLE study_ai_setting (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      ai_enabled boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_ai_setting_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_ai_setting_study_key UNIQUE (owner_id, study_id),
      CONSTRAINT study_ai_setting_revision_check CHECK (revision >= 1)
    );
  `);
  await context.query(`
    CREATE TABLE ai_job (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      capability text NOT NULL,
      trigger text NOT NULL DEFAULT 'user',
      request_key text NOT NULL,
      basis_revision integer NOT NULL,
      consent_version text NOT NULL,
      state text NOT NULL DEFAULT 'queued',
      attempt_count integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_until timestamptz,
      lease_token uuid,
      error_code text,
      model_id text,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cost_micros bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      PRIMARY KEY (id),
      CONSTRAINT ai_job_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_job_owner_study_id_key UNIQUE (owner_id, study_id, id),
      CONSTRAINT ai_job_request_key UNIQUE (owner_id, request_key),
      CONSTRAINT ai_job_capability_check CHECK (capability IN ('summary')),
      CONSTRAINT ai_job_trigger_check CHECK (trigger IN ('user', 'automatic')),
      CONSTRAINT ai_job_state_check
        CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      CONSTRAINT ai_job_running_lease_check
        CHECK (state <> 'running' OR (lease_until IS NOT NULL AND lease_token IS NOT NULL)),
      CONSTRAINT ai_job_finished_check
        CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
      CONSTRAINT ai_job_counters_check
        CHECK (attempt_count >= 0 AND input_tokens >= 0 AND output_tokens >= 0
               AND cost_micros >= 0 AND basis_revision >= 1),
      CONSTRAINT ai_job_request_key_length_check CHECK (char_length(request_key) <= 200)
    );
  `);
  await context.query(`
    CREATE INDEX ai_job_queued_idx ON ai_job (available_at) WHERE state = 'queued';
  `);
  await context.query(`
    CREATE INDEX ai_job_running_idx ON ai_job (lease_until) WHERE state = 'running';
  `);
  await context.query(`CREATE INDEX ai_job_owner_created_idx ON ai_job (owner_id, created_at);`);
  await context.query(`
    CREATE TABLE context_manifest (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL,
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      retrieval_rules_version text NOT NULL,
      token_budget integer NOT NULL,
      token_count integer NOT NULL,
      entries jsonb NOT NULL,
      omissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      coverage_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT context_manifest_job_key UNIQUE (owner_id, study_id, job_id),
      CONSTRAINT context_manifest_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT context_manifest_job_fk
        FOREIGN KEY (owner_id, study_id, job_id)
        REFERENCES ai_job (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT context_manifest_tokens_check
        CHECK (token_budget > 0 AND token_count >= 0 AND token_count <= token_budget)
    );
  `);
  await context.query(`
    CREATE TABLE ai_result (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL,
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      capability text NOT NULL,
      basis_revision integer NOT NULL,
      model_id text NOT NULL,
      prompt_version text NOT NULL,
      schema_version text NOT NULL,
      output_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT ai_result_job_key UNIQUE (owner_id, study_id, job_id),
      CONSTRAINT ai_result_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_result_job_fk
        FOREIGN KEY (owner_id, study_id, job_id)
        REFERENCES ai_job (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_result_capability_check CHECK (capability IN ('summary'))
    );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) OR EXISTS (SELECT 1 FROM ai_job)
           OR EXISTS (SELECT 1 FROM "user" WHERE ai_consent_version IS NOT NULL) THEN
          RAISE EXCEPTION 'AI data drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE ai_result;`);
  await context.query(`DROP TABLE context_manifest;`);
  await context.query(`DROP TABLE ai_job;`);
  await context.query(`DROP TABLE study_ai_setting;`);
  await context.query(`
    ALTER TABLE "user"
      DROP CONSTRAINT user_ai_settings_revision_check,
      DROP CONSTRAINT user_ai_enabled_needs_consent_check,
      DROP COLUMN ai_settings_revision,
      DROP COLUMN ai_consented_at,
      DROP COLUMN ai_consent_version,
      DROP COLUMN ai_enabled;
  `);
}
