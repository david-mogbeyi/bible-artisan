import { randomBytes } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';
import {
  importCorpus,
  readCorpusArtifact,
} from '../src/modules/bible-content/corpus/corpus-importer';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { CANDIDATES_SQL } from '../src/modules/bible-content/search/search.service';
import { tokenize } from '../src/modules/bible-content/search/search-text';
import {
  SEARCH_VECTOR_BLANKED_CHARS,
  searchVectorSql,
} from '../src/modules/bible-content/search/search-vector';

/**
 * BIB-16: `search_vector` must not depend on the database's LC_CTYPE. PostgreSQL's default
 * text-search parser classifies non-ASCII characters through LC_CTYPE; under `C` every one of
 * them counts as a letter, so a raw `to_tsvector('simple', text)` keeps `lord’s` or `“behold—you`
 * as one lexeme, and the prefilter drops the verse. This suite builds a real `LC_CTYPE 'C'`
 * database (template0), runs every migration and imports the pinned corpus into it, and checks
 * the stored vectors and the production candidate query there. No Scripture is typed: every
 * input is taken from stored verses at run time. The temporary database is dropped afterwards.
 */

interface VerseVector {
  k: string;
  text: string;
  bookCode: string;
  lexemes: string[];
}

const NON_ASCII = /[\u0080-\u{10FFFF}]/gu;
const WORD = /[\p{L}\p{M}\p{N}]/u;

const vectorsOf = (db: Database, expression: string): Promise<VerseVector[]> =>
  db.query<VerseVector>(
    `SELECT book_code || ' ' || chapter || ':' || verse AS k, text, book_code AS "bookCode",
            tsvector_to_array(${expression}) AS lexemes
       FROM bible_verse
      ORDER BY book_code, chapter, verse`,
    { type: QueryTypes.SELECT },
  );

/** Verses where some tokenizer token is missing from the vector's lexemes (the prefilter loses it). */
async function lostVerses(db: Database, rows: VerseVector[]): Promise<string[]> {
  const tokens = [...new Set(rows.flatMap((r) => tokenize(r.text).tokens.map((t) => t.norm)))];
  const parsed = await db.query<{ token: string; lexemes: string[] }>(
    `SELECT t AS token, tsvector_to_array(to_tsvector('simple'::regconfig, t)) AS lexemes
       FROM unnest($1::text[]) AS t`,
    { bind: [tokens], type: QueryTypes.SELECT },
  );
  const lexemesOf = new Map(parsed.map((r) => [r.token, r.lexemes]));
  return rows
    .filter((r) => {
      const have = new Set(r.lexemes);
      return tokenize(r.text).tokens.some((t) => {
        const need = lexemesOf.get(t.norm) ?? [];
        return need.length === 0 || !need.every((l) => have.has(l));
      });
    })
    .map((r) => r.k);
}

describe('search_vector is locale-independent (BIB-16)', () => {
  const baseUrl = loadEnv().DATABASE_URL;
  const tempName = `bib_search_ctype_c_${randomBytes(4).toString('hex')}`;
  let admin: Database;
  let main: Database;
  let cLocale: Database | undefined;

  beforeAll(async () => {
    main = createDatabase(baseUrl);
    admin = createDatabase(baseUrl);
    await admin.query(
      `CREATE DATABASE "${tempName}" WITH TEMPLATE template0 LC_CTYPE 'C' LC_COLLATE 'C' ENCODING 'UTF8'`,
    );
    const url = new URL(baseUrl);
    url.pathname = `/${tempName}`;
    // Created last: sequelize-typescript binds the model classes to the newest instance, and the
    // importer writes through them. `main` is only queried with raw SQL.
    cLocale = createDatabase(url.toString());
    await migrateToLatest(cLocale);
    await importCorpus(cLocale, readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
  }, 300_000);

  afterAll(async () => {
    await cLocale?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${tempName}" WITH (FORCE)`);
    await admin.close();
    await main.close();
  });

  it('blanks exactly the non-ASCII characters of the imported corpus, none a letter or digit', async () => {
    const rows = await main.query<{ text: string }>(`SELECT text FROM bible_verse`, {
      type: QueryTypes.SELECT,
    });
    expect(rows).toHaveLength(31103);
    const found = new Set<string>();
    for (const { text } of rows) for (const [ch] of text.matchAll(NON_ASCII)) found.add(ch);
    const hex = (chars: Iterable<string>): string[] =>
      Array.from(chars, (ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).sort();
    // A new character (or any non-ASCII letter, which `C` would also lower-case differently)
    // fails here: it needs a decision and a migration, not a silent prefilter miss.
    expect(hex(found)).toStrictEqual(hex(SEARCH_VECTOR_BLANKED_CHARS));
    for (const ch of found) expect(WORD.test(ch)).toBe(false);
  });

  it('keeps the generated column on the shared expression', async () => {
    for (const db of [main, cLocale]) {
      const [column] = await (db as Database).query<{ expression: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
           FROM pg_attribute a
           JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'bible_verse'::regclass AND a.attname = 'search_vector'`,
        { type: QueryTypes.SELECT },
      );
      const spaces = ' '.repeat(SEARCH_VECTOR_BLANKED_CHARS.length);
      expect(column?.expression).toBe(
        `to_tsvector('simple'::regconfig, translate(text, '${SEARCH_VECTOR_BLANKED_CHARS}'::text, '${spaces}'::text))`,
      );
    }
    // And the app's builder produces that same vector for every verse.
    const [drift] = await main.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bible_verse
        WHERE search_vector IS DISTINCT FROM ${searchVectorSql('text')}`,
      { type: QueryTypes.SELECT },
    );
    expect(drift).toStrictEqual({ n: 0 });
  });

  it('really is a C-locale database, where the raw expression loses words next to curly quotes and dashes', async () => {
    const c = cLocale as Database;
    const [locale] = await c.query<{ ctype: string }>(
      `SELECT datctype AS ctype FROM pg_database WHERE datname = current_database()`,
      { type: QueryTypes.SELECT },
    );
    expect(locale).toStrictEqual({ ctype: 'C' });
    // Without `translate`, thousands of verses would be dropped by the prefilter here.
    const raw = await lostVerses(c, await vectorsOf(c, `to_tsvector('simple'::regconfig, text)`));
    expect(raw.length).toBeGreaterThan(1000);
    // The migration's probe, without `translate`, fails under C: it would have caught this.
    const [probe] = await c.query<{ raw: string; fixed: string }>(
      `SELECT to_tsvector('simple'::regconfig, p)::text AS raw,
              ${searchVectorSql('p')}::text AS fixed
         FROM (SELECT U&'a\\00A0b\\2014c\\2018d\\2019e\\201Cf\\201Dg' AS p) s`,
      { type: QueryTypes.SELECT },
    );
    const expected = `'a':1 'b':2 'c':3 'd':4 'e':5 'f':6 'g':7`;
    expect(probe?.fixed).toBe(expected);
    expect(probe?.raw).not.toBe(expected);
  });

  it('stores the same vector for every verse under C as under the test database locale', async () => {
    const c = cLocale as Database;
    const [inC, inMain] = await Promise.all([
      vectorsOf(c, 'search_vector'),
      vectorsOf(main, 'search_vector'),
    ]);
    expect(inC).toHaveLength(31103);
    expect(inC.map((r) => [r.k, r.lexemes])).toStrictEqual(inMain.map((r) => [r.k, r.lexemes]));
    expect(await lostVerses(c, inC)).toStrictEqual([]);
  });

  it('finds words next to curly quotes and em dashes with the production candidate query under C', async () => {
    const c = cLocale as Database;
    const [edition] = await c.query<{ id: string }>(
      `SELECT id FROM bible_edition WHERE activated_at IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    const rows = await vectorsOf(c, 'search_vector');
    // Every 25th verse with two consecutive words where a blanked character touches either word
    // (`word’s`, `“word`, `word—word`): exactly the words the raw expression glues together.
    const blanked = (ch: string | undefined): boolean =>
      ch !== undefined && SEARCH_VECTOR_BLANKED_CHARS.includes(ch);
    const cases: { k: string; bookCode: string; terms: string }[] = [];
    let touching = 0;
    for (const r of rows) {
      const { tokens } = tokenize(r.text);
      const pair = tokens.findIndex((t, j) => {
        const next = tokens[j + 1];
        if (!next) return false;
        return blanked(r.text[t.end]) || blanked(r.text[next.start - 1]);
      });
      const [a, b] = [tokens[pair], tokens[pair + 1]];
      if (pair < 0 || !a || !b) continue;
      if (touching++ % 25 === 0) {
        cases.push({ k: r.k, bookCode: r.bookCode, terms: `${a.norm} ${b.norm}` });
      }
    }
    expect(touching).toBeGreaterThan(10_000);
    expect(cases.length).toBeGreaterThan(400);
    for (const { k, bookCode, terms } of cases) {
      const found = await c.query<{ bookCode: string; chapter: number; verse: number }>(
        CANDIDATES_SQL,
        {
          bind: [edition?.id, terms, bookCode, null, null, null, null, 100_000],
          type: QueryTypes.SELECT,
        },
      );
      expect(found.map((f) => `${f.bookCode} ${f.chapter}:${f.verse}`)).toContain(k);
    }
  });
});
