import type { MigrationContext } from '../src/database/migrator';

// BIB-22: archive, trash and restore (PRD sections 11, 23, 24, 28; FR-STUDY-005/006).
//
// `study.archived_at` / `study.deleted_at` (PRD section 23's names): when the study was archived,
// and when it was moved to the trash. `lifecycle` (BIB-9's CHECK) stays the state; the timestamps
// must agree with it (`study_lifecycle_timestamps_check`):
//
//   active   -> archived_at NULL, deleted_at NULL
//   archived -> archived_at set,  deleted_at NULL
//   trashed  -> deleted_at set; archived_at set exactly when the study was archived when trashed
//
// So a trashed study remembers the state it was trashed from, and restore returns it there
// without another column.
//
// `study_lifecycle_transition` refuses every lifecycle change the product does not offer, so a
// bug or a hand-written UPDATE cannot, say, move a trashed study straight to archived when it
// was active, or un-trash it by any route other than restore:
//
//   active   -> archived            (archive)
//   archived -> active              (unarchive)
//   active   -> trashed             (trash)
//   archived -> trashed             (trash; archived_at kept)
//   trashed  -> active              (restore, only when archived_at IS NULL)
//   trashed  -> archived            (restore, only when archived_at IS NOT NULL)
//
// It fires only when `lifecycle` itself changes (`WHEN OLD IS DISTINCT FROM NEW`), so ordinary
// edits never reach it. Fixed, content-free message, SQLSTATE 23000, like the other study
// triggers. The 30-day recovery window is enforced by the API (the study lock and every read
// treat an expired trashed study as absent) and the purge, not here.
//
// Existing archived/trashed rows (development only: nothing writes those states before this
// migration) are backfilled from `updated_at`.
//
// `down` drops the columns, constraint and trigger. It refuses while any study exists unless
// ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum): the dates are user data, and each `down`
// commits on its own, so an unguarded step here would commit before BIB-21's guard refuses,
// leaving a half-reverted database.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      ADD COLUMN archived_at timestamptz,
      ADD COLUMN deleted_at timestamptz;
  `);
  await context.query(`
    UPDATE study SET archived_at = updated_at WHERE lifecycle = 'archived';
    UPDATE study SET deleted_at = updated_at WHERE lifecycle = 'trashed';
  `);
  await context.query(`
    ALTER TABLE study ADD CONSTRAINT study_lifecycle_timestamps_check CHECK (
      (lifecycle = 'active' AND archived_at IS NULL AND deleted_at IS NULL)
      OR (lifecycle = 'archived' AND archived_at IS NOT NULL AND deleted_at IS NULL)
      OR (lifecycle = 'trashed' AND deleted_at IS NOT NULL)
    );
  `);
  await context.query(`
    CREATE FUNCTION study_lifecycle_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF (OLD.lifecycle = 'active' AND NEW.lifecycle IN ('archived', 'trashed'))
         OR (OLD.lifecycle = 'archived' AND NEW.lifecycle IN ('active', 'trashed'))
         OR (OLD.lifecycle = 'trashed' AND NEW.lifecycle = 'active' AND OLD.archived_at IS NULL)
         OR (OLD.lifecycle = 'trashed' AND NEW.lifecycle = 'archived'
             AND OLD.archived_at IS NOT NULL)
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'study lifecycle transition refused'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER study_lifecycle_transition
      BEFORE UPDATE OF lifecycle ON study
      FOR EACH ROW
      WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle)
      EXECUTE FUNCTION study_lifecycle_transition();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'study lifecycle drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TRIGGER IF EXISTS study_lifecycle_transition ON study;`);
  await context.query(`DROP FUNCTION IF EXISTS study_lifecycle_transition();`);
  await context.query(`
    ALTER TABLE study
      DROP CONSTRAINT IF EXISTS study_lifecycle_timestamps_check,
      DROP COLUMN IF EXISTS deleted_at,
      DROP COLUMN IF EXISTS archived_at;
  `);
}
