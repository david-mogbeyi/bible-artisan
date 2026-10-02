import type { MigrationContext } from '../src/database/migrator';

// BIB-24: highlights (PRD section 23 `Annotation`; FR-BIBLE-006/007) and Scripture targets for
// notes (section 23 `Note.target_reference_id` / `phrase_anchor_json`).
//
// `annotation` is study-scoped: `(owner_id, study_id) -> study (owner_id, id)`, cascading, so a
// study purge or user delete removes its highlights, and a highlight can never name another
// owner's study.
// - `anchor_json`: the durable anchor (BIB-18 `scriptureAnchorSchema`, version 1) exactly as the
//   API re-checked it against the corpus before writing; the CHECK only pins its shape's root.
//   Quote, offsets and checksums are private text: never logged or put in events.
// - `reference_id`: the shared, immutable `scripture_reference` row for the anchor's verses (from
//   `AnchorService`), for labels and the event. `edition_id`, `book_code`, `start_chapter`,
//   `end_chapter` are derived from the same checked anchor and serve the reader's chapter query
//   (`highlights on chapter C`: start_chapter <= C <= end_chapter); never sent by a client.
// - `color_token`: one of the four named colors (PRD section 15); `label` optional, at most 80
//   code points (`char_length` counts code points, as the API does).
// - `deleted_at`: deleted (soft; undo/restore is BIB-31), written with the database clock.
//
// Indexes: `annotation_study_idx` (owner_id, study_id), over every row, backs the composite FK so
// a study purge or user delete cascades by index, never a scan (the partial chapter index skips
// deleted highlights, so it cannot serve the cascade); `annotation_chapter_idx` (live rows only)
// serves the reader's chapter query. The FKs to `scripture_reference` (`annotation.reference_id`,
// `note.target_reference_id`) need no supporting index: those rows can never be deleted or
// updated (BIB-15 trigger), so the FKs never look rows up from the referenced side.
//
// `note` gains a Scripture target: `target_reference_id` (the anchor's verses) and
// `target_anchor_json` (the checked anchor), both set or both null, and never together with
// `target_node_id`, so a note has at most one target.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): highlights and note targets are user data, and each `down` commits on its own, so an
// unguarded step here would commit before BIB-23's guard refused, leaving a half-reverted database.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE annotation (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      study_id uuid NOT NULL,
      owner_id uuid NOT NULL,
      reference_id uuid NOT NULL REFERENCES scripture_reference (id),
      edition_id uuid NOT NULL,
      book_code text NOT NULL,
      start_chapter integer NOT NULL,
      end_chapter integer NOT NULL,
      anchor_json jsonb NOT NULL,
      color_token text NOT NULL,
      label text,
      revision integer NOT NULL DEFAULT 1,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT annotation_study_owner_fk
        FOREIGN KEY (owner_id, study_id) REFERENCES study (owner_id, id) ON DELETE CASCADE,
      CONSTRAINT annotation_anchor_json_check
        CHECK (jsonb_typeof(anchor_json) = 'object' AND anchor_json -> 'version' = '1'::jsonb),
      CONSTRAINT annotation_chapters_check
        CHECK (start_chapter >= 1 AND end_chapter >= start_chapter),
      CONSTRAINT annotation_color_token_check
        CHECK (color_token IN ('yellow', 'green', 'blue', 'pink')),
      CONSTRAINT annotation_label_check
        CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
      CONSTRAINT annotation_revision_check CHECK (revision >= 1)
    );
  `);
  await context.query(`CREATE INDEX annotation_study_idx ON annotation (owner_id, study_id);`);
  await context.query(`
    CREATE INDEX annotation_chapter_idx
      ON annotation (owner_id, study_id, edition_id, book_code, start_chapter)
      WHERE deleted_at IS NULL;
  `);
  await context.query(`
    ALTER TABLE note
      ADD COLUMN target_reference_id uuid REFERENCES scripture_reference (id),
      ADD COLUMN target_anchor_json jsonb,
      ADD CONSTRAINT note_scripture_target_check CHECK (
        (target_reference_id IS NULL) = (target_anchor_json IS NULL)
        AND (target_anchor_json IS NULL
             OR (jsonb_typeof(target_anchor_json) = 'object'
                 AND target_anchor_json -> 'version' = '1'::jsonb))
        AND (target_node_id IS NULL OR target_reference_id IS NULL)
      );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'annotation drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`
    ALTER TABLE note
      DROP CONSTRAINT IF EXISTS note_scripture_target_check,
      DROP COLUMN IF EXISTS target_anchor_json,
      DROP COLUMN IF EXISTS target_reference_id;
  `);
  await context.query(`DROP TABLE IF EXISTS annotation;`);
}
