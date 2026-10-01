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
// - UNIQUE (owner_id, study_id, id) is the branch root FK's target; UNIQUE (owner_id, study_id,
//   id, type) the question pointers'.
//
// `study` gets its starting reference and the original/main question pointers. Each pointer is
// a composite FK into study_node that includes the owner and study, so it can only name a node
// of the same study and owner (PRD section 23), and the node type (below). The original question is kept;
// BIB-20 changes only the main one. The reference fixes the edition, so PRD section 23's
// separate starting_translation_id is not needed and "both or neither" holds by construction.
//
// `study_branch` is the initial investigation route (PRD section 8). Only the columns creation
// writes: label, parent, deletion and memberships belong to the tickets that use them (BIB-33).
// Its composite FKs make both the study and the root node same-owner, same-study.
//
// Question pointers name questions only. `study.question_node_type` is a STORED generated
// constant 'question', and each pointer FK is (owner_id, id, <node>, question_node_type) ->
// study_node (owner_id, study_id, id, type), backed by UNIQUE (owner_id, study_id, id, type).
// Node type is immutable (PRD section 8), and the FK itself refuses a type change on a pointed-at
// node, so a pointer can never come to name a non-question.
//
// Hard delete (PRD: 30-day trash purge, account deletion) is one statement. Every study-scoped
// child FK to study (study_node, study_event, study_branch; the BIB-9 ones are altered here) is
// ON DELETE CASCADE, and so is study -> user (auth_session and mutation_receipt already cascade
// from user). The study -> node pointers and the branch -> root node FK stay NO ACTION: they are
// checked at the end of the statement, when a cascading delete has removed both sides, so
// `DELETE FROM study` or `DELETE FROM "user"` needs no manual ordering, while deleting a node on
// its own that a pointer or branch still names is refused.
//
// FKs to scripture_reference never fire on delete: those rows can never be deleted (BIB-15
// triggers).
//
// `down` destroys user data (question statements, statuses, Scripture node references, the
// study's starting passage and pointers, branches). It refuses, with a fixed content-free error
// and nothing changed, while any of that data exists, unless ALLOW_STUDY_DATA_DROP=1 is set in
// the migrator's environment (ADR 0001, BIB-19 addendum). It is the newest migration, so a `down`
// toward the corpus stops here first instead of committing this drop and then being refused by
// the corpus guards.
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
      ADD CONSTRAINT study_node_owner_id_study_id_id_key UNIQUE (owner_id, study_id, id),
      ADD CONSTRAINT study_node_owner_id_study_id_id_type_key UNIQUE (owner_id, study_id, id, type),
      DROP CONSTRAINT study_node_study_owner_fk,
      ADD CONSTRAINT study_node_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE;
  `);
  await context.query(`
    ALTER TABLE study_event
      DROP CONSTRAINT study_event_study_owner_fk,
      ADD CONSTRAINT study_event_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE;
  `);
  await context.query(`
    ALTER TABLE study
      ADD COLUMN starting_reference_id uuid REFERENCES scripture_reference (id),
      ADD COLUMN original_question_node_id uuid,
      ADD COLUMN main_question_node_id uuid,
      ADD COLUMN question_node_type text NOT NULL GENERATED ALWAYS AS ('question') STORED,
      ADD CONSTRAINT study_original_question_node_fk
        FOREIGN KEY (owner_id, id, original_question_node_id, question_node_type)
        REFERENCES study_node (owner_id, study_id, id, type),
      ADD CONSTRAINT study_main_question_node_fk
        FOREIGN KEY (owner_id, id, main_question_node_id, question_node_type)
        REFERENCES study_node (owner_id, study_id, id, type),
      DROP CONSTRAINT study_owner_id_fkey,
      ADD CONSTRAINT study_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES "user" (id) ON DELETE CASCADE;
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
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT study_branch_root_node_fk
        FOREIGN KEY (owner_id, study_id, root_node_id)
        REFERENCES study_node (owner_id, study_id, id)
    );
  `);
  await context.query(`CREATE INDEX study_branch_study_id_idx ON study_branch (study_id);`);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    // Fixed, content-free refusal; the migration's transaction rolls back and nothing changes.
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study_branch)
          OR EXISTS (
            SELECT 1 FROM study_node
             WHERE title IS NOT NULL OR question_status IS NOT NULL
                OR scripture_reference_id IS NOT NULL
          )
          OR EXISTS (
            SELECT 1 FROM study
             WHERE starting_reference_id IS NOT NULL OR original_question_node_id IS NOT NULL
                OR main_question_node_id IS NOT NULL
          )
        THEN
          RAISE EXCEPTION 'study roots drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP TABLE IF EXISTS study_branch;`);
  await context.query(`
    ALTER TABLE study
      DROP CONSTRAINT IF EXISTS study_main_question_node_fk,
      DROP CONSTRAINT IF EXISTS study_original_question_node_fk,
      DROP COLUMN IF EXISTS question_node_type,
      DROP COLUMN IF EXISTS main_question_node_id,
      DROP COLUMN IF EXISTS original_question_node_id,
      DROP COLUMN IF EXISTS starting_reference_id,
      DROP CONSTRAINT study_owner_id_fkey,
      ADD CONSTRAINT study_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES "user" (id);
  `);
  await context.query(`
    ALTER TABLE study_event
      DROP CONSTRAINT study_event_study_owner_fk,
      ADD CONSTRAINT study_event_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id);
  `);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT study_node_study_owner_fk,
      ADD CONSTRAINT study_node_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id),
      DROP CONSTRAINT IF EXISTS study_node_owner_id_study_id_id_type_key,
      DROP CONSTRAINT IF EXISTS study_node_owner_id_study_id_id_key,
      DROP CONSTRAINT IF EXISTS study_node_scripture_check,
      DROP CONSTRAINT IF EXISTS study_node_question_check,
      DROP CONSTRAINT IF EXISTS study_node_type_check,
      DROP COLUMN IF EXISTS scripture_reference_id,
      DROP COLUMN IF EXISTS question_status,
      DROP COLUMN IF EXISTS title;
  `);
}
