import type { MigrationContext } from '../src/database/migrator';

// BIB-31: node delete and restore (PRD section 23 "Integrity and deletion rules").
//
// - `study_edge.deleted_with_node_id`: the node whose deletion removed this edge, so restoring that
//   node brings back exactly those edges and never one the user removed on purpose.
// - `study_edge_deleted_with_node_fk`: a composite FK to `study_node (owner_id, study_id, id)`, NO
//   ACTION like the endpoint FKs, so it can only name a node of the edge's own study and owner.
// - `study_edge_deleted_with_check`: only a deleted edge carries it, and only one of its own
//   endpoints.
// - `study_edge_deleted_with_idx`: partial, backs the restore lookup and the FK's referencing side.
// No backfill: no node could be deleted before this migration.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): the column is the only record of which edges a deletion removed.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_edge
      ADD COLUMN deleted_with_node_id uuid,
      ADD CONSTRAINT study_edge_deleted_with_node_fk
        FOREIGN KEY (owner_id, study_id, deleted_with_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      ADD CONSTRAINT study_edge_deleted_with_check
        CHECK (deleted_with_node_id IS NULL OR (deleted_at IS NOT NULL
               AND deleted_with_node_id IN (source_node_id, target_node_id)));
  `);
  await context.query(`
    CREATE INDEX study_edge_deleted_with_idx
      ON study_edge (owner_id, study_id, deleted_with_node_id)
      WHERE deleted_with_node_id IS NOT NULL;
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'edge deleted-with drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP INDEX study_edge_deleted_with_idx;`);
  await context.query(`
    ALTER TABLE study_edge
      DROP CONSTRAINT study_edge_deleted_with_check,
      DROP CONSTRAINT study_edge_deleted_with_node_fk,
      DROP COLUMN deleted_with_node_id;
  `);
}
