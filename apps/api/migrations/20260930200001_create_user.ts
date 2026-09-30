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

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS "user";`);
}
