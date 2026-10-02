import type { MigrationContext } from '../src/database/migrator';

// BIB-26: one canonical Scripture node per exact reference in a study (PRD sections 12, 23, 28;
// FR-GRAPH-002/003).
//
// - `canonical_node_id`: NULL for a canonical node (and every non-Scripture node); set on a
//   deliberate duplicate, naming the canonical node it copies. No separate `is_canonical` column:
//   it would always equal `canonical_node_id IS NULL`.
// - The composite self-FK (owner_id, study_id, canonical_node_id, scripture_reference_id) ->
//   study_node (owner_id, study_id, id, scripture_reference_id), backed by a UNIQUE on the target
//   columns, so a duplicate can only name a node of the same owner, study and reference (and
//   BIB-25's identity trigger keeps both rows' reference fixed). NO ACTION, like the branch root
//   FK: checked at the end of the statement, so a study or user purge deletes both sides in one
//   cascade, while deleting a canonical row on its own that a duplicate names is refused.
// - CHECK: only a Scripture node can be a duplicate, and never of itself.
// - No duplicate-of-duplicate chains: the constraint trigger `study_node_canonical_target`
//   (fires after INSERT, or UPDATE OF canonical_node_id, at the end of the statement) refuses a
//   row whose canonical_node_id names a node that is itself a duplicate, and the reverse, a node
//   that duplicates already name becoming a duplicate. It locks the target row FOR UPDATE, so two
//   concurrent writes (A becomes a duplicate while C is added as a duplicate of A) serialize and
//   the second sees the first. Like the other triggers, the function pins
//   `search_path = pg_catalog, pg_temp`, schema-qualifies the table, and raises a fixed,
//   content-free SQLSTATE 23000.
// - The partial unique index allows at most one live canonical Scripture node per (study,
//   reference); the reference already fixes range and edition (BIB-15), so this is PRD section
//   23's study/reference/edition key. Deleted rows are outside it, so once BIB-31 adds node
//   delete, a new canonical node can be created while a deleted one (and duplicates still naming
//   it) remain; promoting a duplicate and restore conflicts are BIB-31's. It also serves the
//   service's canonical lookup.
// - `study_node_canonical_node_idx` backs the self-FK's referencing side, so deleting nodes (a
//   purge) checks duplicates by index instead of scanning the study's nodes per row. Duplicates
//   are rare, so it is tiny.
//
// Backfill, before the index: in each study, among live Scripture rows of one reference, the
// oldest (created_at, then id) stays canonical and the others become its duplicates. Nothing is
// deleted or merged; no other column (revision, updated_at) changes and no event is written. On
// main nothing writes a second live Scripture node of one reference (BIB-25 refused it), so this
// only matters for rows inserted by hand.
//
// `down` refuses while any study exists unless ALLOW_STUDY_DATA_DROP=1 (ADR 0001, BIB-19
// addendum): it drops which nodes are labeled duplicates. With the opt-in, duplicate rows stay
// as plain Scripture rows (a re-applied `up` backfills them again, oldest canonical).
/** A plain lower-case identifier: safe to double-quote into DDL. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function nodeSchema(context: MigrationContext): Promise<string> {
  const [row] = await context.select<{ schema: string | null }>(
    'SELECT current_schema() AS schema',
  );
  if (!row?.schema || !SCHEMA_NAME.test(row.schema)) {
    throw new Error('add_canonical_scripture_nodes: unsupported current schema');
  }
  return `"${row.schema}"`;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const s = await nodeSchema(context);
  await context.query(`
    ALTER TABLE study_node
      ADD COLUMN canonical_node_id uuid,
      ADD CONSTRAINT study_node_canonical_check CHECK (
        canonical_node_id IS NULL OR (type = 'scripture' AND canonical_node_id <> id)
      ),
      ADD CONSTRAINT study_node_owner_id_study_id_id_scripture_reference_id_key
        UNIQUE (owner_id, study_id, id, scripture_reference_id),
      ADD CONSTRAINT study_node_canonical_node_fk
        FOREIGN KEY (owner_id, study_id, canonical_node_id, scripture_reference_id)
        REFERENCES study_node (owner_id, study_id, id, scripture_reference_id);
  `);
  await context.query(`
    WITH ranked AS (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY study_id, scripture_reference_id ORDER BY created_at, id
             ) AS canonical_id
        FROM study_node
       WHERE type = 'scripture' AND deleted_at IS NULL
    )
    UPDATE study_node n
       SET canonical_node_id = r.canonical_id
      FROM ranked r
     WHERE n.id = r.id AND r.canonical_id <> n.id;
  `);
  await context.query(`
    CREATE UNIQUE INDEX study_node_canonical_scripture_key
      ON study_node (study_id, scripture_reference_id)
      WHERE type = 'scripture' AND canonical_node_id IS NULL AND deleted_at IS NULL;
  `);
  await context.query(`
    CREATE INDEX study_node_canonical_node_idx
      ON study_node (study_id, canonical_node_id)
      WHERE canonical_node_id IS NOT NULL;
  `);
  // After the backfill, which only ever points a row at its partition's oldest (canonical) row.
  await context.query(`
    CREATE FUNCTION ${s}.study_node_canonical_target() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
    DECLARE
      target_canonical uuid;
    BEGIN
      IF NEW.canonical_node_id IS NULL THEN
        RETURN NULL;
      END IF;
      SELECT t.canonical_node_id INTO target_canonical
        FROM ${s}.study_node t
       WHERE t.id = NEW.canonical_node_id
         FOR UPDATE;
      IF target_canonical IS NOT NULL
         OR EXISTS (SELECT 1 FROM ${s}.study_node d WHERE d.canonical_node_id = NEW.id) THEN
        RAISE EXCEPTION 'a duplicate study node must name a canonical node'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END
    $$;
  `);
  await context.query(`
    CREATE CONSTRAINT TRIGGER study_node_canonical_target
      AFTER INSERT OR UPDATE OF canonical_node_id ON ${s}.study_node
      FOR EACH ROW EXECUTE FUNCTION ${s}.study_node_canonical_target();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  if (process.env.ALLOW_STUDY_DATA_DROP !== '1') {
    // Fixed, content-free refusal; the migration's transaction rolls back and nothing changes.
    await context.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM study) THEN
          RAISE EXCEPTION 'canonical scripture nodes drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END
      $$;
    `);
  }
  const s = await nodeSchema(context);
  await context.query(`DROP TRIGGER IF EXISTS study_node_canonical_target ON ${s}.study_node;`);
  await context.query(`DROP FUNCTION IF EXISTS ${s}.study_node_canonical_target();`);
  await context.query(`DROP INDEX IF EXISTS study_node_canonical_node_idx;`);
  await context.query(`DROP INDEX IF EXISTS study_node_canonical_scripture_key;`);
  await context.query(`
    ALTER TABLE study_node
      DROP CONSTRAINT IF EXISTS study_node_canonical_node_fk,
      DROP CONSTRAINT IF EXISTS study_node_owner_id_study_id_id_scripture_reference_id_key,
      DROP CONSTRAINT IF EXISTS study_node_canonical_check,
      DROP COLUMN IF EXISTS canonical_node_id;
  `);
}
