import type { MigrationContext } from '../src/database/migrator';

// BIB-60: branch membership (PRD sections 8, 23: "StudyBranchMember — branch_id; node_id;
// study_id; owner_id; … unique branch/node … Index branch/node and node/branch").
//
// `study_branch` gains:
// - `revision` (>= 1, existing branches start at 1): the optimistic check for membership edits
//   (AGENTS.md rule 4). Starting a branch checks the study's revision instead.
// - `study_branch_owner_id_study_id_id_key` UNIQUE (owner_id, study_id, id): the member FK's
//   target, so a member row can only name a branch of its own study and owner (rule 2).
// - `study_branch_root_key` UNIQUE (study_id, root_node_id): one branch per root (the API's
//   BRANCH_EXISTS check runs under the study lock; this is the backstop). Existing data has at most
//   one branch per study, so it applies cleanly.
//
// `study_branch_member`: one row per (branch, member node). The root is never stored as a member.
// - PK (branch_id, node_id): "unique branch/node" and the branch → node lookup; its branch_id
//   prefix backs the branch FK's referencing side.
// - `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE: a study purge or user
//   delete removes memberships.
// - `(owner_id, study_id, branch_id) -> study_branch (owner_id, study_id, id)` and
//   `(owner_id, study_id, node_id) -> study_node (owner_id, study_id, id)`: a membership naming
//   another study's or another owner's branch or node is unwritable (NFR-SEC-001). NO ACTION, like
//   `note_target_node_fk`: branches and nodes are never hard-deleted on their own, and a study
//   purge deletes them and their memberships in one cascading statement, where NO ACTION is
//   checked at the end of the statement.
// - `study_branch_member_node_idx` (owner_id, study_id, node_id): "node/branch" lookups and the
//   node FK's referencing side; its (owner_id, study_id) prefix backs the study FK's cascade.
//
// Removing a member deletes its row; the `branch_members_changed` event keeps the history.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): memberships are user data, and each `down` commits on its own.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_branch
      ADD COLUMN revision integer NOT NULL DEFAULT 1,
      ADD CONSTRAINT study_branch_revision_check CHECK (revision >= 1),
      ADD CONSTRAINT study_branch_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id),
      ADD CONSTRAINT study_branch_root_key UNIQUE (study_id, root_node_id);
  `);
  await context.query(`
    CREATE TABLE study_branch_member (
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      branch_id uuid NOT NULL,
      node_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (branch_id, node_id),
      CONSTRAINT study_branch_member_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_branch_member_branch_fk
        FOREIGN KEY (owner_id, study_id, branch_id)
        REFERENCES study_branch (owner_id, study_id, id),
      CONSTRAINT study_branch_member_node_fk
        FOREIGN KEY (owner_id, study_id, node_id)
        REFERENCES study_node (owner_id, study_id, id)
    );
  `);
  await context.query(`
    CREATE INDEX study_branch_member_node_idx
      ON study_branch_member (owner_id, study_id, node_id);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'branch membership drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  // With the opt-in, memberships and branch revisions are dropped; branches themselves stay (the
  // earlier schema allows several per study), and `branch_created` / `branch_members_changed`
  // events keep their ids.
  await context.query(`DROP TABLE study_branch_member;`);
  await context.query(`
    ALTER TABLE study_branch
      DROP CONSTRAINT study_branch_root_key,
      DROP CONSTRAINT study_branch_owner_id_study_id_id_key,
      DROP CONSTRAINT study_branch_revision_check,
      DROP COLUMN revision;
  `);
}
