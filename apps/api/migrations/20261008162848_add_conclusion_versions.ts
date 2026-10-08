import type { MigrationContext } from '../src/database/migrator';

// BIB-30: immutable conclusion versions with an evidence snapshot, and "Established by me"
// (PRD sections 8, 12, 23; FR-CONCLUSION-001...005).
//
// - `study_node.established_at`: when the owner marked a conclusion established (database clock),
//   else NULL. `study_node_established_check` (a stable name: BIB-62 widens it to observations)
//   makes "established only on a supported conclusion" unwritable otherwise.
// - `study_edge UNIQUE (owner_id, study_id, id)`: the FK target BIB-27 deferred to the first FK
//   that names an edge (`node_version_evidence_edge_fk`).
// - `node_version`: one immutable row per conclusion change. `node_type` is a STORED generated
//   constant 'conclusion', so `(owner_id, study_id, node_id, node_type) -> study_node (owner_id,
//   study_id, id, type)` lets only a conclusion of the same study and owner be versioned (BIB-19's
//   pattern). `UNIQUE (node_id, version_number)` also serves "newest first". CHECKs: the 7
//   actions, the 5 statuses, statement 1-4,000, a reason of 1-2,000 and required for revised /
//   abandoned versions, established only while supported. A trigger refuses every UPDATE (fixed,
//   content-free message, SQLSTATE 23000), like `note_version`.
// - `node_version_evidence`: the live supporting / challenging edges at the moment of that
//   version, relational (not JSON) so the composite FKs make a cross-study or cross-owner row
//   unwritable. Its edge, node and node-version pointers cascade: nodes and edges are only
//   soft-deleted, so a hard delete is a study purge or a user delete, and the evidence must go
//   with them whatever order PostgreSQL fires the cascades in (NO ACTION failed on the
//   two-level cascade study -> node_version -> evidence). The indexes back those FKs'
//   referencing side so a purge never scans.
// - Backfill: version 1 (`created`, no evidence) for every existing conclusion, which until now
//   was always `tentative` and unedited.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): versions are user data, and each `down` commits on its own.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_node
      ADD COLUMN established_at timestamptz,
      ADD CONSTRAINT study_node_established_check
        CHECK (established_at IS NULL OR (type = 'conclusion' AND conclusion_status = 'supported'));
  `);
  await context.query(`
    ALTER TABLE study_edge
      ADD CONSTRAINT study_edge_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id);
  `);
  await context.query(`
    CREATE TABLE node_version (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      node_id uuid NOT NULL,
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      node_type text NOT NULL GENERATED ALWAYS AS ('conclusion') STORED,
      version_number integer NOT NULL,
      action text NOT NULL,
      statement text NOT NULL,
      conclusion_status text NOT NULL,
      established boolean NOT NULL,
      change_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT node_version_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id),
      CONSTRAINT node_version_node_id_version_number_key UNIQUE (node_id, version_number),
      CONSTRAINT node_version_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT node_version_node_fk
        FOREIGN KEY (owner_id, study_id, node_id, node_type)
        REFERENCES study_node (owner_id, study_id, id, type),
      CONSTRAINT node_version_version_number_check CHECK (version_number >= 1),
      CONSTRAINT node_version_action_check CHECK (action IN (
        'created', 'revised', 'challenged', 'abandoned', 'established', 'updated',
        'evidence_removed')),
      CONSTRAINT node_version_statement_check CHECK (char_length(statement) BETWEEN 1 AND 4000),
      CONSTRAINT node_version_status_check CHECK (conclusion_status IN (
        'tentative', 'supported', 'challenged', 'revised', 'abandoned')),
      CONSTRAINT node_version_established_check
        CHECK (NOT established OR conclusion_status = 'supported'),
      CONSTRAINT node_version_reason_check
        CHECK (change_reason IS NULL OR char_length(change_reason) BETWEEN 1 AND 2000),
      CONSTRAINT node_version_reason_required_check
        CHECK (action NOT IN ('revised', 'abandoned') OR change_reason IS NOT NULL)
    );
  `);
  await context.query(`
    CREATE FUNCTION node_version_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'node versions are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER node_version_immutable
      BEFORE UPDATE ON node_version
      FOR EACH ROW EXECUTE FUNCTION node_version_immutable();
  `);
  await context.query(`
    CREATE TABLE node_version_evidence (
      version_id uuid NOT NULL,
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      edge_id uuid NOT NULL,
      edge_type text NOT NULL,
      role text NOT NULL,
      node_id uuid NOT NULL,
      node_revision integer NOT NULL,
      node_version_id uuid,
      PRIMARY KEY (version_id, edge_id),
      CONSTRAINT node_version_evidence_version_fk
        FOREIGN KEY (owner_id, study_id, version_id)
        REFERENCES node_version (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT node_version_evidence_edge_fk
        FOREIGN KEY (owner_id, study_id, edge_id) REFERENCES study_edge (owner_id, study_id, id)
        ON DELETE CASCADE,
      CONSTRAINT node_version_evidence_node_fk
        FOREIGN KEY (owner_id, study_id, node_id) REFERENCES study_node (owner_id, study_id, id)
        ON DELETE CASCADE,
      CONSTRAINT node_version_evidence_node_version_fk
        FOREIGN KEY (owner_id, study_id, node_version_id)
        REFERENCES node_version (owner_id, study_id, id) ON DELETE CASCADE,
      CONSTRAINT node_version_evidence_edge_type_check CHECK (edge_type IN (
        'supports', 'contradicts', 'qualifies', 'explains', 'references', 'answers',
        'raises_question', 'historical_background', 'linguistic_background', 'fulfillment',
        'quotation', 'inference_from', 'derived_from', 'parallels', 'related_to')),
      CONSTRAINT node_version_evidence_role_check CHECK (role IN ('supporting', 'challenging')),
      CONSTRAINT node_version_evidence_node_revision_check CHECK (node_revision >= 1)
    );
  `);
  await context.query(`
    CREATE INDEX node_version_evidence_edge_idx
      ON node_version_evidence (owner_id, study_id, edge_id);
    CREATE INDEX node_version_evidence_node_idx
      ON node_version_evidence (owner_id, study_id, node_id);
    CREATE INDEX node_version_evidence_node_version_idx
      ON node_version_evidence (owner_id, study_id, node_version_id)
      WHERE node_version_id IS NOT NULL;
  `);
  await context.query(`
    CREATE FUNCTION node_version_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'node version evidence is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER node_version_evidence_immutable
      BEFORE UPDATE ON node_version_evidence
      FOR EACH ROW EXECUTE FUNCTION node_version_evidence_immutable();
  `);
  await context.query(`
    INSERT INTO node_version
      (node_id, study_id, owner_id, version_number, action, statement, conclusion_status,
       established, created_at)
    SELECT id, study_id, owner_id, 1, 'created', title, conclusion_status, false, created_at
      FROM study_node
     WHERE type = 'conclusion';
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'conclusion versions drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE node_version_evidence;`);
  await context.query(`DROP FUNCTION node_version_evidence_immutable();`);
  await context.query(`DROP TABLE node_version;`);
  await context.query(`DROP FUNCTION node_version_immutable();`);
  await context.query(`
    ALTER TABLE study_edge DROP CONSTRAINT study_edge_owner_id_study_id_id_key;
  `);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT study_node_established_check,
      DROP COLUMN established_at;
  `);
}
