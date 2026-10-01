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
// `study.title_sort_key`: what `sort=title` orders by, `studyTitleSortKey(title)` (the same fold,
// first 200 code points), written by the API wherever it writes the title, and declared
// `COLLATE "C"` so the order is code-point order of the folded title whatever the database's
// default collation (a case- or accent-aware collation would also make the order depend on the
// server's ICU/libc version). Backfilled with the same approximation as `search_text`.
//
// `study.is_pinned`: a STORED GENERATED `pinned_at IS NOT NULL`. The library reads each pin group
// as its own index range (`is_pinned` / `NOT is_pinned`). An expression column could not serve
// the pinned group: PostgreSQL rewrites `(pinned_at IS NULL) = false` to `pinned_at IS NOT NULL`,
// which no longer matches the index expression, so that group fell back to a filter and sort.
//
// One index per sort, `(owner_id, lifecycle, is_pinned, <sort value>, id)` in the listing's
// direction, so every page (first or deep) is a range scan that starts at the cursor
// (PRD section 23: "Index owner/lifecycle/last_activity/id"). The search filter scans one owner's
// rows through the same indexes; no trigram or tsvector index (see ADR 0001, BIB-21 addendum).
//
// Final sigma (`tagKey` step 5, BIB-21): the fold now maps "ς" to "σ" wherever it stands. Every
// stored fold (`tag.normalized_name` from BIB-20, and the columns above) is rewritten with
// `translate(…, 'ς', 'σ')`, which is exactly the new fold of each value. Two of an owner's tags
// cannot collide: the old fold chose the sigma form from the surrounding letters alone, so two
// keys differing only in sigma form never existed. Were one to, the unique constraint would abort
// this migration's transaction and nothing would change. `down` restores the word-final form
// (σ after a non-separator and before a separator or the end), the old fold's choice for
// keys made of letters and separators.
//
// `down` refuses, with a fixed content-free error and nothing changed, while any study exists,
// unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19 addendum). The columns are derived (activity
// from events, search text and sort key from title and description), but each migration's `down`
// commits on its own: an unguarded step here would commit before the BIB-20 guard below it
// refuses, leaving a half-reverted database. Last activity is also only approximately
// recoverable from events.
const FOLD = (column: string): string =>
  `translate(btrim(regexp_replace(lower(normalize(${column}, NFKC)), '\\s+', ' ', 'g')), 'ς', 'σ')`;

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    ALTER TABLE study
      ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN search_text text NOT NULL DEFAULT '',
      ADD COLUMN title_sort_key text COLLATE "C" NOT NULL DEFAULT '',
      ADD COLUMN is_pinned boolean NOT NULL GENERATED ALWAYS AS (pinned_at IS NOT NULL) STORED;
  `);
  await context.query(`
    UPDATE study s
       SET last_activity_at = greatest(
             s.created_at,
             coalesce((SELECT max(e.occurred_at) FROM study_event e
                        WHERE e.owner_id = s.owner_id AND e.study_id = s.id), s.created_at)),
           search_text = concat_ws(E'\\n', ${FOLD('s.title')}, ${FOLD('s.description')}),
           title_sort_key = left(${FOLD('s.title')}, 200);
  `);
  await context.query(`UPDATE tag SET normalized_name = translate(normalized_name, 'ς', 'σ')
                        WHERE strpos(normalized_name, 'ς') > 0;`);
  await context.query(`
    CREATE INDEX study_owner_library_recent_idx
      ON study (owner_id, lifecycle, is_pinned, last_activity_at DESC, id DESC);
    CREATE INDEX study_owner_library_created_idx
      ON study (owner_id, lifecycle, is_pinned, created_at DESC, id DESC);
    CREATE INDEX study_owner_library_title_idx
      ON study (owner_id, lifecycle, is_pinned, title_sort_key COLLATE "C", id);
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
  await context.query(`
    DROP INDEX IF EXISTS study_owner_library_title_idx;
    DROP INDEX IF EXISTS study_owner_library_created_idx;
    DROP INDEX IF EXISTS study_owner_library_recent_idx;
  `);
  await context.query(`
    UPDATE tag
       SET normalized_name = regexp_replace(
             normalized_name, '(?<=[^[:space:][:punct:]])σ(?=[[:space:][:punct:]]|$)', 'ς', 'g')
     WHERE strpos(normalized_name, 'σ') > 0;
  `);
  await context.query(`
    ALTER TABLE study
      DROP COLUMN IF EXISTS is_pinned,
      DROP COLUMN IF EXISTS title_sort_key,
      DROP COLUMN IF EXISTS search_text,
      DROP COLUMN IF EXISTS last_activity_at;
  `);
}
