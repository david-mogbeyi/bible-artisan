import type { MigrationContext } from '../src/database/migrator';

// BIB-55 / BIB-32: the Study Thread columns of `study_event` (PRD sections 13, 23).
//
// - `visibility` visible | internal (PRD section 13's internal-only families), `actor_kind`
//   user | ai | system, `schema_version`, `recorded_at` (server time; `occurred_at` stays the
//   client's occurrence time, so a delayed sync keeps its original time).
// - Navigation: `session_id` (the browser tab's), `node_id`, `from_node_id`, `version_id`,
//   `branch_id`, `parent_visit_event_id`. Node, version and branch ids are soft references
//   (no FK): an event outlives any later physical purge of its target and renders a tombstone;
//   reads scope them by the event's own study and owner. `parent_visit_event_id` is a composite FK
//   to an event of the same study and owner, backed by UNIQUE (owner_id, study_id, id).
// - `client_mutation_id`: unique per owner (FR-THREAD-004: a retried activity is one event).
// - `correlation_id`: the request's correlation id; one action's events share it (FR-THREAD-006).
// - Indexes: study/branch/sequence, study/node/sequence (PRD section 23), study/visibility/sequence
//   for the default visible-only page, study/correlation for a card's records, and the parent
//   visit FK's referencing columns (so deleting a study's events never scans per row).
//
// Backfill: internal visibility by type; node/branch/version ids from the payload keys the
// existing writers use (BIB-19's `study_created` roots its node at the question when it has one,
// else the Scripture node); `recorded_at` = `occurred_at`.
const INTERNAL_TYPES = [
  'phrase_selected',
  'search_performed',
  'note_autosaved',
  'node_position_saved',
  'view_state_saved',
  'summary_queued',
  'summary_failed',
  'session_started',
  'session_ended',
  'study_trashed',
  'study_restored',
];

const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/** The payload key's value as a uuid, or NULL when absent or not a uuid. */
function uuidKey(key: string): string {
  return `CASE WHEN payload_json->>'${key}' ~ ${UUID} THEN (payload_json->>'${key}')::uuid END`;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_event
      ADD COLUMN visibility text NOT NULL DEFAULT 'visible',
      ADD COLUMN actor_kind text NOT NULL DEFAULT 'user',
      ADD COLUMN session_id uuid,
      ADD COLUMN node_id uuid,
      ADD COLUMN from_node_id uuid,
      ADD COLUMN version_id uuid,
      ADD COLUMN branch_id uuid,
      ADD COLUMN parent_visit_event_id uuid,
      ADD COLUMN schema_version smallint NOT NULL DEFAULT 1,
      ADD COLUMN client_mutation_id uuid,
      ADD COLUMN correlation_id uuid,
      ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now(),
      ADD CONSTRAINT study_event_visibility_check CHECK (visibility IN ('visible', 'internal')),
      ADD CONSTRAINT study_event_actor_kind_check CHECK (actor_kind IN ('user', 'ai', 'system')),
      ADD CONSTRAINT study_event_schema_version_check CHECK (schema_version >= 1),
      ADD CONSTRAINT study_event_no_self_parent_check CHECK (parent_visit_event_id <> id),
      ADD CONSTRAINT study_event_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id);
  `);
  await context.query(`
    ALTER TABLE study_event
      ADD CONSTRAINT study_event_parent_visit_fk
        FOREIGN KEY (owner_id, study_id, parent_visit_event_id)
        REFERENCES study_event (owner_id, study_id, id);
  `);
  await context.query(`
    CREATE UNIQUE INDEX study_event_owner_client_mutation_key
      ON study_event (owner_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
    CREATE INDEX study_event_study_branch_sequence_idx
      ON study_event (study_id, branch_id, sequence) WHERE branch_id IS NOT NULL;
    CREATE INDEX study_event_study_node_sequence_idx
      ON study_event (study_id, node_id, sequence) WHERE node_id IS NOT NULL;
    CREATE INDEX study_event_study_visibility_sequence_idx
      ON study_event (study_id, visibility, sequence);
    CREATE INDEX study_event_study_correlation_idx
      ON study_event (study_id, correlation_id) WHERE correlation_id IS NOT NULL;
    CREATE INDEX study_event_parent_visit_idx
      ON study_event (owner_id, study_id, parent_visit_event_id)
      WHERE parent_visit_event_id IS NOT NULL;
  `);
  // Fixed literals from this file, never request data.
  const internal = INTERNAL_TYPES.map((type) => `'${type}'`).join(', ');
  await context.query(
    `UPDATE study_event SET visibility = 'internal' WHERE event_type IN (${internal});`,
  );
  await context.query(`
    UPDATE study_event
       SET recorded_at = occurred_at,
           node_id = CASE event_type
             WHEN 'study_created' THEN COALESCE(${uuidKey('questionNodeId')}, ${uuidKey('scriptureNodeId')})
             WHEN 'main_question_changed' THEN ${uuidKey('toNodeId')}
             WHEN 'node_connected' THEN ${uuidKey('targetNodeId')}
             WHEN 'edge_removed' THEN ${uuidKey('targetNodeId')}
             ELSE COALESCE(${uuidKey('nodeId')}, ${uuidKey('questionNodeId')}, ${uuidKey('rootNodeId')})
           END,
           from_node_id = CASE event_type
             WHEN 'main_question_changed' THEN ${uuidKey('fromNodeId')}
             WHEN 'node_connected' THEN ${uuidKey('sourceNodeId')}
             WHEN 'edge_removed' THEN ${uuidKey('sourceNodeId')}
           END,
           branch_id = ${uuidKey('branchId')},
           version_id = ${uuidKey('versionId')};
  `);
}

// Refuses while any event exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum):
// dropping the columns would lose visit origins, sessions and recorded times. Fixed,
// content-free error.
export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study_event) THEN
          RAISE EXCEPTION 'study event thread columns drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    DROP INDEX IF EXISTS study_event_owner_client_mutation_key;
    DROP INDEX IF EXISTS study_event_study_branch_sequence_idx;
    DROP INDEX IF EXISTS study_event_study_node_sequence_idx;
    DROP INDEX IF EXISTS study_event_study_visibility_sequence_idx;
    DROP INDEX IF EXISTS study_event_study_correlation_idx;
    DROP INDEX IF EXISTS study_event_parent_visit_idx;
  `);
  await context.query(`
    ALTER TABLE study_event
      DROP CONSTRAINT IF EXISTS study_event_parent_visit_fk,
      DROP CONSTRAINT IF EXISTS study_event_owner_id_study_id_id_key,
      DROP CONSTRAINT IF EXISTS study_event_no_self_parent_check,
      DROP CONSTRAINT IF EXISTS study_event_schema_version_check,
      DROP CONSTRAINT IF EXISTS study_event_actor_kind_check,
      DROP CONSTRAINT IF EXISTS study_event_visibility_check,
      DROP COLUMN IF EXISTS recorded_at,
      DROP COLUMN IF EXISTS correlation_id,
      DROP COLUMN IF EXISTS client_mutation_id,
      DROP COLUMN IF EXISTS schema_version,
      DROP COLUMN IF EXISTS parent_visit_event_id,
      DROP COLUMN IF EXISTS branch_id,
      DROP COLUMN IF EXISTS version_id,
      DROP COLUMN IF EXISTS from_node_id,
      DROP COLUMN IF EXISTS node_id,
      DROP COLUMN IF EXISTS session_id,
      DROP COLUMN IF EXISTS actor_kind,
      DROP COLUMN IF EXISTS visibility;
  `);
}
