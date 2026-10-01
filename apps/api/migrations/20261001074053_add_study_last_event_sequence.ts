import type { MigrationContext } from '../src/database/migrator';

// The transactional per-study event counter (PRD §23: "Allocate sequence through a transactional
// per-study counter"). `UPDATE study SET last_event_sequence = last_event_sequence + 1 ...
// RETURNING` holds the study row lock until commit, so concurrent writers to one study get
// consecutive sequences in commit order, and a rolled-back allocation is undone with its
// transaction: no gaps, no duplicates (unique (study_id, sequence) remains the backstop).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      ADD COLUMN last_event_sequence bigint NOT NULL DEFAULT 0,
      ADD CONSTRAINT study_last_event_sequence_check CHECK (last_event_sequence >= 0);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      DROP CONSTRAINT IF EXISTS study_last_event_sequence_check,
      DROP COLUMN IF EXISTS last_event_sequence;
  `);
}
