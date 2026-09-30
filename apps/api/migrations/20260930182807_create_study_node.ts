import { sql, type Kysely } from 'kysely';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table study_node (
      id uuid not null default gen_random_uuid(),
      study_id uuid not null,
      owner_id uuid not null,
      -- Type is immutable after creation (PRD §23): no update path exists for it yet, and
      -- none should be added until Graph's node-mutation ticket defines the real subtypes.
      type text not null,
      revision integer not null default 1,
      deleted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint study_node_pkey primary key (id),
      -- A mismatched owner_id/study_id pair is unwritable: this FK only matches a row in
      -- study whose id AND owner_id agree (NFR-SEC-001).
      constraint study_node_study_owner_fkey
        foreign key (study_id, owner_id) references study (id, owner_id)
    )
  `.execute(db);

  await sql`create index study_node_study_id_idx on study_node (study_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table study_node`.execute(db);
}
