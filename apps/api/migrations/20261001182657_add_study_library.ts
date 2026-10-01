import type { MigrationContext } from '../src/database/migrator';

// BIB-21: what the study library reads (PRD sections 11, 23, 24; FR-STUDY-004).
//
// `study.last_activity_at`: when anything last happened to the study. The API writes it in
// exactly one place, `StudyRevisionService.writeCounters`, in the same UPDATE as the event
// counter whenever a committed mutation appended events (every mutation does), so it moves in
// the mutation's own transaction and a read never moves it. Backfilled from the study's latest
// event (or its creation).
//
// `study.search_text`: the folded title and description (`studySearchText` in
// @bible-artisan/contracts: `tagKey` of each, one per line), which the library search matches
// with `strpos` against folded query words. Folding happens in the API, the same function on both
// sides, so matching does not depend on the database's LC_CTYPE (`lower()` under the C locale
// folds ASCII only). The API writes it wherever it writes the title or description. A migration
// never imports code that may change, so existing rows are backfilled with a close SQL
// approximation (NFKC, `lower()`, whitespace collapsed); the API rewrites the exact value on the
// study's next title or description change. No production data exists yet (hosting is
// undecided, ADR 0001), so only development rows ever carry the approximation.
//
// Index for the default listing (sort=recent): owner, lifecycle, pinned group, last activity,
// id, matching the query's ORDER BY. PRD section 23: "Index owner/lifecycle/last_activity/id".
// The title and created sorts and the search filter scan one owner's rows through the same
// index's leading columns; no trigram or tsvector index (see ADR 0001, BIB-21 addendum).
//
// `down` refuses, with a fixed content-free error and nothing changed, while any study exists,
// unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum). The columns are derived (activity
// from events, search text from title and description), but each migration's `down` commits on
// its own: an unguarded step here would commit before the BIB-20 guard below it refuses, leaving
// a half-reverted database. Last activity is also only approximately recoverable from events.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN search_text text NOT NULL DEFAULT '';
  `);
  await context.query(`
    UPDATE study s
       SET last_activity_at = greatest(
             s.created_at,
             coalesce((SELECT max(e.occurred_at) FROM study_event e
                        WHERE e.owner_id = s.owner_id AND e.study_id = s.id), s.created_at)),
           search_text = concat_ws(
             E'\\n',
             btrim(regexp_replace(lower(normalize(s.title, NFKC)), '\\s+', ' ', 'g')),
             btrim(regexp_replace(lower(normalize(s.description, NFKC)), '\\s+', ' ', 'g')));
  `);
  await context.query(`
    CREATE INDEX study_owner_library_recent_idx
      ON study (owner_id, lifecycle, (pinned_at IS NULL), last_activity_at DESC, id DESC);
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'study library drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  await context.query(`DROP INDEX IF EXISTS study_owner_library_recent_idx;`);
  await context.query(`
    ALTER TABLE study
      DROP COLUMN IF EXISTS search_text,
      DROP COLUMN IF EXISTS last_activity_at;
  `);
}
