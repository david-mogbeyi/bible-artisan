import type { MigrationContext } from '../src/database/migrator';

// BIB-25: the six typed graph nodes (PRD sections 8, 12, 23; FR-GRAPH-001).
//
// `study_node` gains the columns the remaining types need, and each type's columns belong to that
// type only, so a mismatched row is unwritable:
// - `origin`: who or what the content comes from (PRD section 16 badges), set by the API from how
//   the node was made and never by a client: `scripture` for Scripture, `external` for Source,
//   `user` otherwise; `ai` is reserved for Epic 7's accept flow. Existing rows (BIB-19/20 roots)
//   are backfilled `scripture` / `user`. No default: every insert names it.
// - `body`: Observation and Thought text, plain, 1-10,000 code points.
// - `observation_kind`: on, and only on, observations.
// - `conclusion_status`: on, and only on, conclusions (`tentative` at creation; BIB-30 owns the
//   transitions).
// - `payload_json`: a Source's citation, and only that: an object with a string `url` or
//   `locator`. The API validates the whole citation (`sourceSchema`) on every write; the URL is
//   stored, never fetched.
// - `title`: a Question's or Conclusion's statement (1-4,000) or a Source's title (1-200); NULL
//   for every other type.
//
// The Question and Scripture constraints keep their meaning (existing rows stay valid). No route
// ever wrote an Observation, Thought, Conclusion or Source row before this, so the new CHECKs
// validate in place.
//
// A BEFORE UPDATE trigger refuses any change of `type`, `study_id`, `owner_id`, `origin` or
// `scripture_reference_id` (PRD section 12: a node's type and a Scripture node's identity are
// immutable). A study or user delete is not an UPDATE, so cascades still work.
//
// No new index: the existing `(study_id, deleted_at)` index serves the list, the cap count and the
// duplicate-Scripture guard at no more than 2,000 live rows. BIB-26 adds the partial unique index.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): each `down` commits on its own, so an unguarded step here would drop node text and
// citations before an older guard refused, leaving a half-reverted database. With the opt-in it
// also deletes Observation, Thought, Conclusion and Source rows (their content is what it drops),
// detaching any note from them first, so a later `up` validates again.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study_node
      ADD COLUMN origin text,
      ADD COLUMN body text,
      ADD COLUMN observation_kind text,
      ADD COLUMN conclusion_status text,
      ADD COLUMN payload_json jsonb;
  `);
  await context.query(`
    UPDATE study_node
       SET origin = CASE WHEN type = 'scripture' THEN 'scripture' ELSE 'user' END;
  `);
  await context.query(`
    ALTER TABLE study_node
      ALTER COLUMN origin SET NOT NULL,
      DROP CONSTRAINT study_node_question_check,
      DROP CONSTRAINT study_node_scripture_check,
      ADD CONSTRAINT study_node_origin_check
        CHECK (origin IN ('user', 'ai', 'external', 'scripture')),
      ADD CONSTRAINT study_node_question_check CHECK (
        (type = 'question') = (question_status IS NOT NULL)
        AND (question_status IS NULL
             OR question_status IN ('open', 'partially_answered', 'answered', 'deferred'))
      ),
      ADD CONSTRAINT study_node_conclusion_check CHECK (
        (type = 'conclusion') = (conclusion_status IS NOT NULL)
        AND (conclusion_status IS NULL
             OR conclusion_status IN ('tentative', 'supported', 'challenged', 'revised', 'abandoned'))
      ),
      ADD CONSTRAINT study_node_observation_check CHECK (
        (type = 'observation') = (observation_kind IS NOT NULL)
        AND (observation_kind IS NULL
             OR observation_kind IN ('textual_observation', 'interpretation'))
      ),
      ADD CONSTRAINT study_node_scripture_check
        CHECK ((type = 'scripture') = (scripture_reference_id IS NOT NULL)),
      ADD CONSTRAINT study_node_source_check CHECK (
        (type = 'source') = (payload_json IS NOT NULL)
        AND (payload_json IS NULL
             OR (jsonb_typeof(payload_json) = 'object'
                 -- coalesce: an absent key is NULL, and a CHECK that yields NULL passes.
                 AND (coalesce(jsonb_typeof(payload_json -> 'url'), '') = 'string'
                      OR coalesce(jsonb_typeof(payload_json -> 'locator'), '') = 'string')))
      ),
      ADD CONSTRAINT study_node_title_check CHECK (
        CASE
          WHEN type IN ('question', 'conclusion')
            THEN title IS NOT NULL AND char_length(title) BETWEEN 1 AND 4000
          WHEN type = 'source'
            THEN title IS NOT NULL AND char_length(title) BETWEEN 1 AND 200
          ELSE title IS NULL
        END
      ),
      ADD CONSTRAINT study_node_body_check CHECK (
        CASE
          WHEN type IN ('observation', 'thought')
            THEN body IS NOT NULL AND char_length(body) BETWEEN 1 AND 10000
          ELSE body IS NULL
        END
      );
  `);
  await context.query(`
    CREATE FUNCTION study_node_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF NEW.type IS DISTINCT FROM OLD.type
         OR NEW.study_id IS DISTINCT FROM OLD.study_id
         OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
         OR NEW.origin IS DISTINCT FROM OLD.origin
         OR NEW.scripture_reference_id IS DISTINCT FROM OLD.scripture_reference_id THEN
        RAISE EXCEPTION 'a study node''s type, study, owner, origin and reference are immutable'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;
  `);
  await context.query(`
    CREATE TRIGGER study_node_identity_immutable
      BEFORE UPDATE ON study_node
      FOR EACH ROW EXECUTE FUNCTION study_node_identity_immutable();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'typed nodes drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  // With the opt-in, the four types this migration made storable lose their content, so their
  // rows go too (a re-applied `up` could not validate them). A note attached to one stays, as a
  // note on the study. Question and Scripture rows keep their BIB-19 columns.
  //
  // Part of the opt-in data loss, deliberately left as is: `study_event` rows
  // (`observation_created`, `thought_updated`, `source_created`, ...) and `mutation_receipt` rows
  // (their stored responses) keep naming the deleted node ids. The thread is append-only history
  // and events carry ids only, so nothing here rewrites or deletes them; after this `down` those
  // ids resolve to no node, and a replayed Idempotency-Key returns a response for a node that no
  // longer exists. That is acceptable only because ALLOW_STUDY_DATA_DROP=1 is a dev/test opt-in.
  await context.query(`
    UPDATE note SET target_node_id = NULL
     WHERE target_node_id IN (
       SELECT id FROM study_node WHERE type IN ('observation', 'thought', 'conclusion', 'source'));
  `);
  await context.query(`
    DELETE FROM study_node WHERE type IN ('observation', 'thought', 'conclusion', 'source');
  `);
  await context.query(`DROP TRIGGER IF EXISTS study_node_identity_immutable ON study_node;`);
  await context.query(`DROP FUNCTION IF EXISTS study_node_identity_immutable();`);
  // BIB-19's two constraints, exactly as they were.
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT IF EXISTS study_node_body_check,
      DROP CONSTRAINT IF EXISTS study_node_title_check,
      DROP CONSTRAINT IF EXISTS study_node_source_check,
      DROP CONSTRAINT IF EXISTS study_node_scripture_check,
      DROP CONSTRAINT IF EXISTS study_node_observation_check,
      DROP CONSTRAINT IF EXISTS study_node_conclusion_check,
      DROP CONSTRAINT IF EXISTS study_node_question_check,
      DROP CONSTRAINT IF EXISTS study_node_origin_check,
      DROP COLUMN IF EXISTS payload_json,
      DROP COLUMN IF EXISTS conclusion_status,
      DROP COLUMN IF EXISTS observation_kind,
      DROP COLUMN IF EXISTS body,
      DROP COLUMN IF EXISTS origin,
      ADD CONSTRAINT study_node_question_check CHECK (
        (type = 'question') = (question_status IS NOT NULL)
        AND (question_status IS NULL
             OR question_status IN ('open', 'partially_answered', 'answered', 'deferred'))
        AND (type <> 'question' OR (title IS NOT NULL AND char_length(title) BETWEEN 1 AND 4000))
      ),
      ADD CONSTRAINT study_node_scripture_check
        CHECK ((type = 'scripture') = (scripture_reference_id IS NOT NULL));
  `);
}
