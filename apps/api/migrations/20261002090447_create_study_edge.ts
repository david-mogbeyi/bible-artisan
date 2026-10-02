import type { MigrationContext } from '../src/database/migrator';

// BIB-27: typed, directional relationships between two nodes of one study (PRD sections 12, 23;
// FR-GRAPH-004/005/006).
//
// - `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE: a study purge or user delete
//   removes its edges, and an edge can never name another owner's study.
// - Both endpoints through `(owner_id, study_id, <node>) -> study_node (owner_id, study_id, id)`
//   (`study_node_owner_id_study_id_id_key`), so an endpoint from another study or another owner
//   is unwritable (FR-GRAPH-005, NFR-SEC-001). NO ACTION, like `note_target_node_fk`: nodes are
//   only soft-deleted, and a study purge deletes edges and nodes in one cascading statement, where
//   NO ACTION is checked at the end of the statement.
// - CHECKs: the 15 types, no self-edge, two-way types (`parallels`, `related_to`) stored once
//   with `source_node_id < target_node_id` (uuid order), a note of 1-2,000 code points or NULL,
//   origin `user` or `ai` (BIB-42), revision >= 1.
// - `study_edge_live_key`: at most one live edge per study/source/target/type (the dedup
//   backstop; it also serves the API's dedup lookup). A deleted edge does not block a new one.
// - `study_edge_source_idx` / `study_edge_target_idx` (every row, not partial): back the endpoint
//   FKs' referencing side so deleting nodes never scans edges, and the per-node list in both
//   directions. Their `(owner_id, study_id)` prefix backs the study FK's cascade.
// - Trigger `study_edge_identity_immutable` (BEFORE UPDATE): an edge's endpoints, direction,
//   study, owner and origin never change (to reverse one, remove it and connect again). `type`,
//   `note`, `revision`, `deleted_at` and `updated_at` stay updatable. Fixed message, SQLSTATE
//   23000, like `study_node_identity_immutable`. A delete is not an UPDATE, so cascades work.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): edges are user data, and each `down` commits on its own, so an unguarded drop here
// would commit before an older migration's guard refused.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study_edge (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      source_node_id uuid NOT NULL,
      target_node_id uuid NOT NULL,
      type text NOT NULL,
      note text,
      origin text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_edge_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_edge_source_node_fk
        FOREIGN KEY (owner_id, study_id, source_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      CONSTRAINT study_edge_target_node_fk
        FOREIGN KEY (owner_id, study_id, target_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      CONSTRAINT study_edge_type_check CHECK (type IN (
        'supports', 'contradicts', 'qualifies', 'explains', 'references', 'answers',
        'raises_question', 'historical_background', 'linguistic_background', 'fulfillment',
        'quotation', 'inference_from', 'derived_from', 'parallels', 'related_to')),
      CONSTRAINT study_edge_no_self_check CHECK (source_node_id <> target_node_id),
      CONSTRAINT study_edge_symmetric_order_check
        CHECK (type NOT IN ('parallels', 'related_to') OR source_node_id < target_node_id),
      CONSTRAINT study_edge_note_check
        CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
      CONSTRAINT study_edge_origin_check CHECK (origin IN ('user', 'ai')),
      CONSTRAINT study_edge_revision_check CHECK (revision >= 1)
    );
  `);
  await context.query(`
    CREATE UNIQUE INDEX study_edge_live_key
      ON study_edge (study_id, source_node_id, target_node_id, type)
      WHERE deleted_at IS NULL;
  `);
  await context.query(
    `CREATE INDEX study_edge_source_idx ON study_edge (owner_id, study_id, source_node_id);`,
  );
  await context.query(
    `CREATE INDEX study_edge_target_idx ON study_edge (owner_id, study_id, target_node_id);`,
  );
  await context.query(`
    CREATE FUNCTION study_edge_identity_immutable() RETURNS trigger
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
  await context.query(`
    CREATE TRIGGER study_edge_identity_immutable
      BEFORE UPDATE ON study_edge
      FOR EACH ROW EXECUTE FUNCTION study_edge_identity_immutable();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'study edge drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  // With the opt-in, `node_connected` / `edge_updated` / `edge_removed` events and receipts keep
  // naming the dropped edge ids (append-only history, ids only), as BIB-25's `down` documents.
  await context.query(`DROP TABLE study_edge;`);
  await context.query(`DROP FUNCTION study_edge_identity_immutable();`);
}
