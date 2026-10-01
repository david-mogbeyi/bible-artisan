import type { MigrationContext } from '../src/database/migrator';

// `study_node`: minimal columns proving the composite-FK pattern on a second study-scoped table
// (this ticket's "Data changes"). The composite FK to study(owner_id, id) is what makes an
// owner/study mismatch unwritable at the DB level (NFR-SEC-001) — Sequelize's association API
// cannot express a composite FK, so it is raw SQL here (ADR 0001's amendment).
// `type` is immutable after creation; enforced by never exposing an update path for it (no such
// endpoint exists yet — Graph's ticket owns node mutation and must preserve this).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study_node (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      type text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_node_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id)
    );
  `);
  await context.query(`CREATE INDEX study_node_study_id_idx ON study_node (study_id, deleted_at);`);
}

// `down` refuses while any row exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum):
// a fixed, content-free error, and the migration's transaction rolls back, changing nothing.
export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study_node) THEN
          RAISE EXCEPTION 'study_node drop refused: study nodes exist (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS study_node;`);
}
