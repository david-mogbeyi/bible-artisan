import type { MigrationContext } from '../src/database/migrator';

// BIB-48: account deletion (PRD sections 23, 29; FR-PRIVACY-001).
//
// - `user.deletion_requested_at`: set (database clock) when the owner confirms deletion with a
//   fresh OTP. From that moment the account cannot sign in and its sessions no longer resolve.
// - `account_deletion`: the deletion tombstone, one row per deleted account, holding only the
//   opaque user id and timestamps (no email or content). It has NO foreign key to `user`, so it
//   outlives the purge. A user row that matches a tombstone (for example one brought back by a
//   backup restore) is refused sign-in and sessions and is purged again by the worker
//   (PRD section 29: "Restoring a backup reapplies deletion tombstones before serving users").
//
// `down` refuses while any account or tombstone exists unless ALLOW_STUDY_DATA_DROP=1: dropping
// the tombstones would let a restored backup serve a deleted account again, and dropping the mark
// would let an account whose deletion is pending sign in again.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`ALTER TABLE "user" ADD COLUMN deletion_requested_at timestamptz;`);
  await context.query(`
    CREATE TABLE account_deletion (
      user_id uuid NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      purged_at timestamptz,
      PRIMARY KEY (user_id),
      CONSTRAINT account_deletion_purge_order_check
        CHECK (purged_at IS NULL OR purged_at >= requested_at)
    );
  `);
  await context.query(`
    CREATE INDEX user_deletion_requested_idx ON "user" (id) WHERE deletion_requested_at IS NOT NULL;
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM account_deletion) OR EXISTS (SELECT 1 FROM "user") THEN
          RAISE EXCEPTION 'account deletion drop refused: accounts or deletion tombstones exist (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP INDEX user_deletion_requested_idx;`);
  await context.query(`DROP TABLE account_deletion;`);
  await context.query(`ALTER TABLE "user" DROP COLUMN deletion_requested_at;`);
}
