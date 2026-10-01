import type { MigrationContext } from '../src/database/migrator';

// `user`: identity core only (PRD §23, this ticket's "Data changes"). Consent/analytics/default-
// translation columns land with the tickets that read or write them (BIB-10, BIB-14+).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE "user" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      normalized_email text NOT NULL,
      auth_subject text,
      display_name text,
      timezone text NOT NULL DEFAULT 'UTC',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_normalized_email_key UNIQUE (normalized_email),
      CONSTRAINT user_auth_subject_key UNIQUE (auth_subject)
    );
  `);
}

// `down` refuses while any row exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum):
// a fixed, content-free error, and the migration's transaction rolls back, changing nothing.
export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "user") THEN
          RAISE EXCEPTION 'user drop refused: users exist (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS "user";`);
}
