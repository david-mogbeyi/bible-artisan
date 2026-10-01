import type { MigrationContext } from '../src/database/migrator';

// The shared, read-only Bible corpus (BIB-14, PRD §20/§23). Schema only: the data is loaded by
// `pnpm corpus:import` from the committed publisher artifact, never by a migration.
//
// - `bible_edition` is one immutable release of a translation (PRD "BibleTranslation" + edition:
//   a new release gets a new row). `activated_at` is NULL only inside the import transaction.
// - `bible_book` / `bible_verse` hang off an edition; book `code` is the USFM book code, the
//   cross-edition identity. The verse primary key is the PRD's edition/book/chapter/verse B-tree.
//   No search_vector or GIN index yet (BIB-16).
//
// Immutability is enforced here, not by convention (PRD: "Corpus data is shared and read-only"):
// - books and verses can be inserted only while their edition is not activated, and never
//   updated, deleted, or truncated;
// - an edition can never be deleted or truncated, and its only permitted update is activation
//   (activated_at NULL -> timestamp, nothing else changed);
// - activation re-verifies, in SQL, the verse count, every verse's text_sha256, each book's
//   chapter count, and the edition content_sha256, so an incomplete or altered release can never
//   become active even if application validation were bypassed.
// Errors use SQLSTATE 23000 (integrity_constraint_violation) and carry no corpus content.
// `down` drops the tables (DROP TABLE fires no row or TRUNCATE triggers).
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE bible_edition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL CHECK (code ~ '^[a-z0-9]{2,32}$'),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      abbreviation text NOT NULL CHECK (length(abbreviation) BETWEEN 1 AND 20),
      language text NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),
      canon text NOT NULL CHECK (canon IN ('protestant')),
      source_url text NOT NULL CHECK (source_url ~ '^https://'),
      source_release text NOT NULL CHECK (source_release ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
      content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      verse_count integer NOT NULL CHECK (verse_count > 0),
      license_status text NOT NULL CHECK (license_status IN ('public_domain')),
      attribution text NOT NULL CHECK (length(attribution) BETWEEN 1 AND 500),
      rights_record jsonb NOT NULL CHECK (jsonb_typeof(rights_record) = 'object'),
      activated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bible_edition_code_release_key UNIQUE (code, source_release)
    );

    CREATE TABLE bible_book (
      edition_id uuid NOT NULL REFERENCES bible_edition (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code ~ '^[1-4A-Z][A-Z0-9]{2}$'),
      sequence smallint NOT NULL CHECK (sequence > 0),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      abbreviation text NOT NULL CHECK (length(abbreviation) BETWEEN 1 AND 20),
      chapter_count smallint NOT NULL CHECK (chapter_count > 0),
      PRIMARY KEY (edition_id, code),
      CONSTRAINT bible_book_edition_sequence_key UNIQUE (edition_id, sequence)
    );

    CREATE TABLE bible_verse (
      edition_id uuid NOT NULL,
      book_code text NOT NULL,
      chapter smallint NOT NULL CHECK (chapter > 0),
      verse smallint NOT NULL CHECK (verse > 0),
      text text NOT NULL,
      text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY (edition_id, book_code, chapter, verse),
      FOREIGN KEY (edition_id, book_code)
        REFERENCES bible_book (edition_id, code) ON DELETE RESTRICT
    );

    -- The edition checksum, identical to contentSha256() in corpus.ts.
    CREATE FUNCTION bible_edition_content_sha256(p_edition_id uuid) RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT encode(sha256(convert_to(coalesce(string_agg(
        v.book_code || E'\\t' || v.chapter || E'\\t' || v.verse || E'\\t' || v.text || E'\\n',
        '' ORDER BY b.sequence, v.chapter, v.verse), ''), 'UTF8')), 'hex')
      FROM bible_verse v
      JOIN bible_book b ON b.edition_id = v.edition_id AND b.code = v.book_code
      WHERE v.edition_id = p_edition_id
    $$;

    CREATE FUNCTION bible_corpus_refuse_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'bible corpus is immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;

    -- Books and verses may only be added to an edition that is still being imported. FOR SHARE
    -- makes a concurrent activation wait for this insert's transaction (and then count its row),
    -- and makes this insert wait for, then see, a concurrent activation.
    CREATE FUNCTION bible_corpus_guard_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM bible_edition
        WHERE id = NEW.edition_id AND activated_at IS NULL
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'bible corpus is immutable: % into % needs an edition being imported',
          TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;

    CREATE FUNCTION bible_edition_guard_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.activated_at IS NOT NULL OR NEW.activated_at IS NULL
         OR (to_jsonb(NEW) - 'activated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'activated_at') THEN
        RAISE EXCEPTION 'bible corpus is immutable: an edition may only be activated once'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (SELECT count(*) FROM bible_verse WHERE edition_id = NEW.id) <> NEW.verse_count THEN
        RAISE EXCEPTION 'bible edition activation refused: verse count mismatch'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM bible_verse
        WHERE edition_id = NEW.id
          AND text_sha256 <> encode(sha256(convert_to(text, 'UTF8')), 'hex')
      ) THEN
        RAISE EXCEPTION 'bible edition activation refused: verse checksum mismatch'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM bible_book b
        WHERE b.edition_id = NEW.id
          AND b.chapter_count <> (
            SELECT count(DISTINCT v.chapter) FROM bible_verse v
            WHERE v.edition_id = b.edition_id AND v.book_code = b.code
          )
      ) THEN
        RAISE EXCEPTION 'bible edition activation refused: chapter count mismatch'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF bible_edition_content_sha256(NEW.id) <> NEW.content_sha256 THEN
        RAISE EXCEPTION 'bible edition activation refused: content checksum mismatch'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END
    $$;

    CREATE TRIGGER bible_edition_guard_update BEFORE UPDATE ON bible_edition
      FOR EACH ROW EXECUTE FUNCTION bible_edition_guard_update();
    CREATE TRIGGER bible_edition_refuse_delete BEFORE DELETE ON bible_edition
      FOR EACH ROW EXECUTE FUNCTION bible_corpus_refuse_change();
    CREATE TRIGGER bible_edition_refuse_truncate BEFORE TRUNCATE ON bible_edition
      FOR EACH STATEMENT EXECUTE FUNCTION bible_corpus_refuse_change();

    CREATE TRIGGER bible_book_guard_insert BEFORE INSERT ON bible_book
      FOR EACH ROW EXECUTE FUNCTION bible_corpus_guard_insert();
    CREATE TRIGGER bible_book_refuse_change BEFORE UPDATE OR DELETE ON bible_book
      FOR EACH ROW EXECUTE FUNCTION bible_corpus_refuse_change();
    CREATE TRIGGER bible_book_refuse_truncate BEFORE TRUNCATE ON bible_book
      FOR EACH STATEMENT EXECUTE FUNCTION bible_corpus_refuse_change();

    CREATE TRIGGER bible_verse_guard_insert BEFORE INSERT ON bible_verse
      FOR EACH ROW EXECUTE FUNCTION bible_corpus_guard_insert();
    CREATE TRIGGER bible_verse_refuse_change BEFORE UPDATE OR DELETE ON bible_verse
      FOR EACH ROW EXECUTE FUNCTION bible_corpus_refuse_change();
    CREATE TRIGGER bible_verse_refuse_truncate BEFORE TRUNCATE ON bible_verse
      FOR EACH STATEMENT EXECUTE FUNCTION bible_corpus_refuse_change();
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    DROP TABLE IF EXISTS bible_verse;
    DROP TABLE IF EXISTS bible_book;
    DROP TABLE IF EXISTS bible_edition;
    DROP FUNCTION IF EXISTS bible_edition_guard_update();
    DROP FUNCTION IF EXISTS bible_corpus_guard_insert();
    DROP FUNCTION IF EXISTS bible_corpus_refuse_change();
    DROP FUNCTION IF EXISTS bible_edition_content_sha256(uuid);
  `);
}
