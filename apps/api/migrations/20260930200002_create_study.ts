import type { MigrationContext } from '../src/database/migrator';

// `study`: `id` is the primary key; the additional composite `(owner_id, id)` unique key is what
// every study-scoped child table's composite FK must reference (PRD §23, AGENTS.md rule 2 — "a
// mismatched owner/study must be unwritable at the DB level"). Never add an FK to `study (id)`
// alone: test/schema.int-spec.ts fails if any FK into `study` is not the composite one.
// The composite unique key's btree (leading column owner_id) also serves owner-scoped lookups,
// so no separate owner_id index is needed.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE study (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES "user" (id),
      title text NOT NULL,
      description text,
      lifecycle text NOT NULL DEFAULT 'active',
      revision integer NOT NULL DEFAULT 1,
      content_revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT study_owner_id_id_key UNIQUE (owner_id, id),
      CONSTRAINT study_lifecycle_check CHECK (lifecycle IN ('active', 'archived', 'trashed'))
    );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS study;`);
}
