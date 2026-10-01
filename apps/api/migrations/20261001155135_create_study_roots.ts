import type { MigrationContext } from '../src/database/migrator';

// BIB-19: what study creation writes (PRD sections 10, 11, 23; FR-STUDY-001).
//
// `study_node` gets the columns its two root types need, and nothing for later types:
// - `title` holds a Question node's statement (at most 4,000 characters, PRD section 15);
//   `question_status` its user-owned status (PRD section 12; 'open' at creation).
// - `scripture_reference_id` points at the shared, immutable, edition-bound range (BIB-15), so a
//   Scripture node can only name a range that exists in the imported corpus.
// - CHECKs pin the six MVP types and keep each type's columns to that type, so a question
//   without a statement or a Scripture node without a reference is unwritable.
// - UNIQUE (owner_id, study_id, id) is the target every same-study node pointer below needs.
//
// `study` gets its starting reference and the original/main question pointers. Each pointer is
// a composite FK (owner_id, id, <node>) -> study_node (owner_id, study_id, id), so it can only
// name a node of the same study and owner (PRD section 23). The original question is kept;
// BIB-20 changes only the main one. The reference fixes the edition, so PRD section 23's
// separate starting_translation_id is not needed and "both or neither" holds by construction.
//
// `study_branch` is the initial investigation route (PRD section 8). Only the columns creation
// writes: label, parent, deletion and memberships belong to the tickets that use them (BIB-33).
// Its composite FKs make both the study and the root node same-owner, same-study.
//
// FKs to scripture_reference never fire on delete: those rows can never be deleted (BIB-15
// triggers). This migration's `down` runs before the corpus guards, so it never blocks them.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_node
      ADD COLUMN title text,
      ADD COLUMN question_status text,
      ADD COLUMN scripture_reference_id uuid REFERENCES scripture_reference (id),
      ADD CONSTRAINT study_node_type_check CHECK (
        type IN ('scripture', 'question', 'observation', 'thought', 'conclusion', 'source')
      ),
      ADD CONSTRAINT study_node_question_check CHECK (
        (type = 'question') = (question_status IS NOT NULL)
        AND (question_status IS NULL OR question_status IN ('open', 'partially_answered', 'answered', 'deferred'))
        AND (type <> 'question' OR (title IS NOT NULL AND char_length(title) BETWEEN 1 AND 4000))
      ),
      ADD CONSTRAINT study_node_scripture_check CHECK (
        (type = 'scripture') = (scripture_reference_id IS NOT NULL)
      ),
      ADD CONSTRAINT study_node_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id);
  `);
  await context.query(`
    ALTER TABLE study
      ADD COLUMN starting_reference_id uuid REFERENCES scripture_reference (id),
      ADD COLUMN original_question_node_id uuid,
      ADD COLUMN main_question_node_id uuid,
      ADD CONSTRAINT study_original_question_node_fk
        FOREIGN KEY (owner_id, id, original_question_node_id)
        REFERENCES study_node (owner_id, study_id, id),
      ADD CONSTRAINT study_main_question_node_fk
        FOREIGN KEY (owner_id, id, main_question_node_id)
        REFERENCES study_node (owner_id, study_id, id);
  `);
  await context.query(`
    CREATE TABLE study_branch (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      root_node_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT study_branch_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id),
      CONSTRAINT study_branch_root_node_fk
        FOREIGN KEY (owner_id, study_id, root_node_id)
        REFERENCES study_node (owner_id, study_id, id)
    );
  `);
  await context.query(`CREATE INDEX study_branch_study_id_idx ON study_branch (study_id);`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS study_branch;`);
  await context.query(`
    ALTER TABLE study
      DROP CONSTRAINT IF EXISTS study_main_question_node_fk,
      DROP CONSTRAINT IF EXISTS study_original_question_node_fk,
      DROP COLUMN IF EXISTS main_question_node_id,
      DROP COLUMN IF EXISTS original_question_node_id,
      DROP COLUMN IF EXISTS starting_reference_id;
  `);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT IF EXISTS study_node_owner_id_study_id_id_key,
      DROP CONSTRAINT IF EXISTS study_node_scripture_check,
      DROP CONSTRAINT IF EXISTS study_node_question_check,
      DROP CONSTRAINT IF EXISTS study_node_type_check,
      DROP COLUMN IF EXISTS scripture_reference_id,
      DROP COLUMN IF EXISTS question_status,
      DROP COLUMN IF EXISTS title;
  `);
}
