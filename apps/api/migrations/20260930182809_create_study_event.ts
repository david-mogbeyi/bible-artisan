import { sql, type Kysely } from 'kysely';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table study_event (
      id uuid not null default gen_random_uuid(),
      study_id uuid not null,
      owner_id uuid not null,
      sequence bigint not null,
      event_type text not null,
      payload_json jsonb not null default '{}',
      occurred_at timestamptz not null default now(),
      constraint study_event_pkey primary key (id),
      -- A mismatched owner_id/study_id pair is unwritable (NFR-SEC-001), same pattern as study_node.
      constraint study_event_study_owner_fkey
        foreign key (study_id, owner_id) references study (id, owner_id),
      -- Proves the append-only, gap-free-per-study shape; BIB-12 owns the transactional allocator.
      constraint study_event_study_sequence_unique unique (study_id, sequence)
    )
  `.execute(db);

  await sql`create index study_event_study_id_idx on study_event (study_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table study_event`.execute(db);
}
