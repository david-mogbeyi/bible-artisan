import type { MigrationContext } from '../src/database/migrator';

// BIB-62: an Observation can be marked "Established by me" (PRD sections 8, 12, 17). Widens
// BIB-30's `study_node_established_check` so `established_at` is writable on an observation as
// well as on a supported conclusion; every other node type stays unwritable. No backfill.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): it clears observation markers, which are user data, before restoring the narrower
// CHECK.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT study_node_established_check,
      ADD CONSTRAINT study_node_established_check
        CHECK (established_at IS NULL OR type = 'observation'
               OR (type = 'conclusion' AND conclusion_status = 'supported'));
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'established observations drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    UPDATE study_node SET established_at = NULL
     WHERE type = 'observation' AND established_at IS NOT NULL;
  `);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT study_node_established_check,
      ADD CONSTRAINT study_node_established_check
        CHECK (established_at IS NULL OR (type = 'conclusion' AND conclusion_status = 'supported'));
  `);
}
