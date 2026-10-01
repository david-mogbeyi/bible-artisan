import type { MigrationContext } from '../src/database/migrator';

// `auth_session`: server-side sessions behind the HttpOnly session cookie (BIB-10, PRD §29).
// Only the SHA-256 of the random cookie token is stored. Validity (not revoked, under the
// 30-day absolute `expires_at`, seen within 7 days) is checked in the identity service.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE auth_session (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      CONSTRAINT auth_session_token_hash_key UNIQUE (token_hash)
    );
  `);
  await context.query(`CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS auth_session;`);
}
