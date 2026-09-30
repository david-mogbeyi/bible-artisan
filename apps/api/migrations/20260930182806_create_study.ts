import { sql, type Kysely } from 'kysely';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table study (
      id uuid not null default gen_random_uuid(),
      owner_id uuid not null references "user" (id),
      title text not null,
      description text,
      lifecycle text not null default 'active',
      revision integer not null default 1,
      content_revision integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint study_pkey primary key (id),
      -- Composite (id, owner_id) is how every child table's FK proves ownership at the DB level.
      constraint study_id_owner_id_unique unique (id, owner_id),
      constraint study_lifecycle_check check (lifecycle in ('active', 'archived', 'trashed'))
    )
  `.execute(db);

  await sql`create index study_owner_id_idx on study (owner_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table study`.execute(db);
}
