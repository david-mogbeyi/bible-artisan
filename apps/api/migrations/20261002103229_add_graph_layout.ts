import type { MigrationContext } from '../src/database/migrator';

// BIB-28: the persistent graph layout (PRD sections 12, 23, 24, 27; FR-GRAPH-007/009).
//
// `study_view_state`: one row per study, created by the study's first position save. Its
// `revision` is the study's **view revision** (PRD section 23 "Separate view_revision from content
// revision"): `PATCH /positions` checks it instead of the study revision, so moving nodes never
// conflicts with a content edit and never moves `study.revision` or `content_revision`.
// - `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE; UNIQUE (owner_id, study_id)
//   keeps it one row per study (the mutation creates it under the study lock, this is the
//   backstop) and serves the owner-scoped lookup.
//
// `study_node_position`: a node's stored canvas position ("NodePosition rows keyed
// owner/study/node"), in canvas units.
// - PK (study_id, node_id): one position per node, the upsert's conflict target and the
//   snapshot's lookup (its study_id prefix backs the study FK's cascade too).
// - `(owner_id, study_id) -> study` ON DELETE CASCADE, and `(owner_id, study_id, node_id) ->
//   study_node (owner_id, study_id, id)` (`study_node_owner_id_study_id_id_key`) ON DELETE CASCADE:
//   a position for another study's or another owner's node is unwritable (NFR-SEC-001), and a
//   position has no meaning without its node, so a hard node delete or a study purge removes it.
//   A soft-deleted node keeps its row (a restore keeps its place, BIB-31); reads skip it.
// - CHECK: both coordinates within ±1,000,000. `BETWEEN` is false for NaN and the infinities, so
//   they are refused too (the API's schema refuses them first).
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): layouts are user data, and each `down` commits on its own.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study_view_state (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_view_state_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_view_state_study_key UNIQUE (owner_id, study_id),
      CONSTRAINT study_view_state_revision_check CHECK (revision >= 1)
    );
  `);
  await context.query(`
    CREATE TABLE study_node_position (
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      node_id uuid NOT NULL,
      x double precision NOT NULL,
      y double precision NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (study_id, node_id),
      CONSTRAINT study_node_position_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_node_position_node_fk
        FOREIGN KEY (owner_id, study_id, node_id)
        REFERENCES study_node (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT study_node_position_bounds_check
        CHECK (x BETWEEN -1000000 AND 1000000 AND y BETWEEN -1000000 AND 1000000)
    );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'graph layout drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  // With the opt-in, `node_position_saved` events keep their counts (ids and numbers only).
  await context.query(`DROP TABLE study_node_position;`);
  await context.query(`DROP TABLE study_view_state;`);
}
