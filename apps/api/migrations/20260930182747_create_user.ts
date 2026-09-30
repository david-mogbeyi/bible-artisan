import { sql, type Kysely } from 'kysely';

// Write SQL-first DDL: CHECK constraints, composite FKs and partial indexes are expected (PRD §23).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "user" (
      id uuid primary key default gen_random_uuid(),
      normalized_email text not null,
      auth_subject text,
      display_name text,
      timezone text not null default 'UTC',
      created_at timestamptz not null default now(),
      constraint user_normalized_email_unique unique (normalized_email),
      constraint user_auth_subject_unique unique (auth_subject)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table "user"`.execute(db);
}
