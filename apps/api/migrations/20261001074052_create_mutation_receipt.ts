import type { MigrationContext } from '../src/database/migrator';

// `mutation_receipt` (PRD §23): one row per committed mutation that carried an Idempotency-Key,
// so a retry replays the original response instead of executing again (FR-STUDY-002).
// - The primary key (owner_id, idempotency_key) scopes keys per user: two users can never collide
//   on, or read, each other's receipts. It is also the unique index that makes a concurrent
//   duplicate wait for the first request's transaction (MutationService).
// - The row is claimed (inserted) before the mutation's work runs and its response is filled in
//   before COMMIT, all in one transaction, so a committed row always has a response. The response
//   columns are nullable only for that in-transaction window, hence the paired CHECK.
// - Not study-scoped (POST /studies has no study yet), so it references the user, not study.
// - Purging expired rows needs the job runner (BIB-39); an expired key may be reclaimed meanwhile.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE mutation_receipt (
      owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      idempotency_key uuid NOT NULL,
      route text NOT NULL,
      request_hash text NOT NULL,
      response_status integer,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (owner_id, idempotency_key),
      CONSTRAINT mutation_receipt_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT mutation_receipt_response_check CHECK (
        (response_status IS NULL AND response_body IS NULL)
        OR (response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)
      ),
      CONSTRAINT mutation_receipt_expiry_check CHECK (expires_at > created_at)
    );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS mutation_receipt;`);
}
