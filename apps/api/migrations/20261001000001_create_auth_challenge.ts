import type { MigrationContext } from '../src/database/migrator';

// `auth_challenge`: one row per email sign-in code sent (BIB-10, PRD §29). Enforces the PRD's
// per-code attempt limit, single use, 10-minute expiry, and per-email 60 s resend window in
// PostgreSQL, independently of the managed OTP provider. Stores NO code or code hash: the
// provider verifies codes ("avoid building credential storage").
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE auth_challenge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      normalized_email text NOT NULL,
      provider_ref text,
      attempt_count integer NOT NULL DEFAULT 0,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT auth_challenge_attempt_count_check CHECK (attempt_count BETWEEN 0 AND 5)
    );
  `);
  await context.query(`
    CREATE INDEX auth_challenge_email_created_idx
      ON auth_challenge (normalized_email, created_at DESC);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS auth_challenge;`);
}
