import type { MigrationContext } from '../src/database/migrator';

// BIB-57: an Observation or Thought converted from a note excerpt remembers the note (PRD sections
// 8, 15, 21). Provenance is a column, not an edge: notes are not graph nodes.
//
// - `study_node.derived_from_note_id`: the note the node was converted from, set once at creation.
// - `study_node_derived_from_note_fk`: composite FK to `note (owner_id, study_id, id)`, NO ACTION
//   (notes are only hard-deleted by the study cascade, where both sides go in one statement). Not
//   SET NULL: that would try to null the NOT NULL `owner_id` / `study_id`.
// - `study_node_derived_from_note_check`: only an observation or a thought carries it.
// - `study_node_derived_from_note_idx`: partial, backs the FK's referencing side.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): the column is the only record of which note a node came from.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_node
      ADD COLUMN derived_from_note_id uuid,
      ADD CONSTRAINT study_node_derived_from_note_fk
        FOREIGN KEY (owner_id, study_id, derived_from_note_id)
        REFERENCES note (owner_id, study_id, id),
      ADD CONSTRAINT study_node_derived_from_note_check
        CHECK (derived_from_note_id IS NULL OR type IN ('observation', 'thought'));
  `);
  await context.query(`
    CREATE INDEX study_node_derived_from_note_idx
      ON study_node (owner_id, study_id, derived_from_note_id)
      WHERE derived_from_note_id IS NOT NULL;
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'node derived-from drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP INDEX study_node_derived_from_note_idx;`);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT study_node_derived_from_note_check,
      DROP CONSTRAINT study_node_derived_from_note_fk,
      DROP COLUMN derived_from_note_id;
  `);
}
