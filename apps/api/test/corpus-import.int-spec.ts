import { spawn } from 'node:child_process';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleSuperscription } from '../src/database/models/bible-superscription.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import {
  contentSha256,
  CorpusValidationError,
  type ParsedCorpus,
  parseArtifact,
  sha256Hex,
} from '../src/modules/bible-content/corpus/corpus';
import {
  importCorpus,
  readCorpusArtifact,
} from '../src/modules/bible-content/corpus/corpus-importer';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';

/** A schema of its own, so a genuinely fresh import (and its failures) can be exercised without
 * touching the corpus the rest of the suite reads from `public`. Dropped afterwards (DROP fires no
 * row or TRUNCATE triggers). */
const SCHEMA = 'corpus_import_test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMMUTABLE = /bible corpus is immutable/;

const archive = readCorpusArtifact(ENGWEBP_RELEASE);
const COUNTS = {
  books: 66,
  chapters: 1189,
  verses: 31103,
  superscriptions: 138,
  artifactSha256: ENGWEBP_RELEASE.artifactSha256,
  contentSha256: ENGWEBP_RELEASE.contentSha256,
};

/** The same artifact content with an archive comment appended: different bytes and SHA-256. */
function withArchiveComment(bytes: Buffer): Buffer {
  const comment = Buffer.from('another generation');
  const copy = Buffer.concat([bytes, comment]);
  copy.writeUInt16LE(comment.length, bytes.length - 2);
  return copy;
}

interface Snapshot {
  editions: unknown[];
  books: number;
  verses: number;
  superscriptions: number;
  content: string | null;
}

describe('WEB corpus import (BIB-14)', { timeout: 60_000 }, () => {
  const url = loadEnv().DATABASE_URL;
  let admin: Database;
  let db: Database;
  let parsed: ParsedCorpus;

  async function snapshot(): Promise<Snapshot> {
    const editions = await db.query(
      `SELECT id, code, source_release, artifact_sha256, content_sha256, verse_count,
              activated_at, created_at
       FROM bible_edition ORDER BY created_at`,
      { type: QueryTypes.SELECT },
    );
    const [counts] = await db.query<{
      books: number;
      verses: number;
      superscriptions: number;
      content: string | null;
    }>(
      `SELECT (SELECT count(*)::int FROM bible_book) AS books,
              (SELECT count(*)::int FROM bible_verse) AS verses,
              (SELECT count(*)::int FROM bible_superscription) AS superscriptions,
              (SELECT bible_edition_content_sha256(id) FROM bible_edition LIMIT 1) AS content`,
      { type: QueryTypes.SELECT },
    );
    return {
      editions,
      books: counts?.books ?? -1,
      verses: counts?.verses ?? -1,
      superscriptions: counts?.superscriptions ?? -1,
      content: counts?.content ?? null,
    };
  }

  async function sqlFailure(sql: string): Promise<unknown> {
    try {
      await db.query(sql);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  beforeAll(async () => {
    admin = createDatabase(url);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
    db = createDatabase(scoped.toString());
    await migrateToLatest(db);
    parsed = parseArtifact(archive, ENGWEBP_RELEASE);
  });

  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  it('imports the committed artifact once, even when two imports race', async () => {
    const results = await Promise.all([
      importCorpus(db, archive, ENGWEBP_RELEASE),
      importCorpus(db, archive, ENGWEBP_RELEASE),
    ]);
    const editionId = results[0].editionId;
    expect(results.map((r) => r.result).sort()).toStrictEqual(['already_current', 'imported']);
    expect(results.map(({ result: _result, ...rest }) => rest)).toStrictEqual([
      { editionId: expect.stringMatching(UUID), ...COUNTS },
      { editionId, ...COUNTS },
    ]);

    const edition = await BibleEdition.findOne({ rejectOnEmpty: true });
    expect(edition.get({ plain: true })).toStrictEqual({
      id: editionId,
      code: 'engwebp',
      name: ENGWEBP_RELEASE.name,
      abbreviation: 'WEBP',
      language: 'en',
      canon: 'protestant',
      sourceUrl: 'https://ebible.org/Scriptures/engwebp_usfm.zip',
      sourceRelease: '2026-09-29',
      artifactSha256: ENGWEBP_RELEASE.artifactSha256,
      contentSha256: ENGWEBP_RELEASE.contentSha256,
      verseCount: 31103,
      superscriptionCount: 138,
      licenseStatus: 'public_domain',
      attribution: ENGWEBP_RELEASE.attribution,
      rightsRecord: ENGWEBP_RELEASE.rightsRecord,
      activatedAt: expect.any(Date),
      createdAt: expect.any(Date),
    });

    const [shape] = await db.query<Record<string, number | string>>(
      `SELECT (SELECT count(*)::int FROM bible_book) AS books,
              (SELECT sum(chapter_count)::int FROM bible_book) AS chapters,
              (SELECT count(DISTINCT (book_code, chapter))::int FROM bible_verse) AS verse_chapters,
              (SELECT count(*)::int FROM bible_verse) AS verses,
              (SELECT count(*)::int FROM bible_verse WHERE text = '') AS empty,
              (SELECT count(*)::int FROM bible_superscription) AS superscriptions,
              (SELECT string_agg(DISTINCT book_code, ',') FROM bible_superscription)
                AS superscription_books,
              bible_edition_content_sha256($1) AS content`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(shape).toStrictEqual({
      books: 66,
      chapters: 1189,
      verse_chapters: 1189,
      verses: 31103,
      empty: 5,
      superscriptions: 138,
      superscription_books: 'PSA',
      content: ENGWEBP_RELEASE.contentSha256,
    });
  });

  it('makes every verse addressable by edition, book, chapter and verse, with its stored text', async () => {
    const edition = await BibleEdition.findOne({ rejectOnEmpty: true });
    const stored = await BibleVerse.findAll({ where: { editionId: edition.id }, raw: true });
    const byKey = new Map(stored.map((v) => [`${v.bookCode} ${v.chapter}:${v.verse}`, v]));
    expect(byKey.size).toBe(parsed.verses.length);
    for (const v of parsed.verses) {
      const row = byKey.get(`${v.bookCode} ${v.chapter}:${v.verse}`);
      expect(row?.text === v.text && row.textSha256 === sha256Hex(v.text)).toBe(true);
    }
    const books = await BibleBook.findAll({
      where: { editionId: edition.id },
      order: [['sequence', 'ASC']],
    });
    expect(books.map((b) => b.code)).toStrictEqual(ENGWEBP_RELEASE.books.map((b) => b.code));

    const superscriptions = await BibleSuperscription.findAll({
      where: { editionId: edition.id },
      order: [
        ['chapter', 'ASC'],
        ['beforeVerse', 'ASC'],
      ],
      raw: true,
    });
    expect(superscriptions).toStrictEqual(
      parsed.superscriptions.map((d) => ({ ...d, editionId: edition.id })),
    );
  });

  it('is a verified no-op when run again with the same artifact', async () => {
    const before = await snapshot();
    const result = await importCorpus(db, archive, ENGWEBP_RELEASE);
    expect(result).toStrictEqual({
      result: 'already_current',
      editionId: expect.stringMatching(UUID),
      ...COUNTS,
    });
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses an artifact whose SHA-256 differs from the pinned release, changing nothing', async () => {
    const before = await snapshot();
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 30] = (tampered[tampered.length - 30] ?? 0) ^ 0x01;
    await expect(importCorpus(db, tampered, ENGWEBP_RELEASE)).rejects.toMatchObject({
      code: 'CORPUS_ARTIFACT_CHECKSUM',
    });
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses the same release from a different artifact, changing nothing', async () => {
    const before = await snapshot();
    // Same text, different bytes: a release pinned to these bytes parses and validates, then
    // collides with the stored release imported from the original artifact.
    const other = withArchiveComment(archive);
    const otherArtifact = { ...ENGWEBP_RELEASE, artifactSha256: sha256Hex(other) };
    await expect(importCorpus(db, other, otherArtifact)).rejects.toMatchObject({
      code: 'CORPUS_RELEASE_CONFLICT',
    });
    expect(await snapshot()).toStrictEqual(before);
  });

  it('writes nothing when validation fails, so the active release stays as it was', async () => {
    const before = await snapshot();
    for (const [manifest, code] of [
      [{ verseCount: 31102 }, 'CORPUS_VERSE_COUNT'],
      [{ superscriptionCount: 137 }, 'CORPUS_SUPERSCRIPTION_COUNT'],
    ] as const) {
      const newRelease = { ...ENGWEBP_RELEASE, ...manifest, sourceRelease: '2099-01-01' };
      const error = await importCorpus(db, archive, newRelease).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CorpusValidationError);
      expect(error).toMatchObject({ code });
    }
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses every change to an activated edition at the database level', async () => {
    const before = await snapshot();
    for (const sql of [
      `UPDATE bible_verse SET text = text`,
      `UPDATE bible_verse SET text_sha256 = text_sha256 WHERE book_code = 'GEN'`,
      `DELETE FROM bible_verse WHERE book_code = 'REV'`,
      `TRUNCATE bible_verse CASCADE`,
      `UPDATE bible_book SET name = name`,
      `DELETE FROM bible_book WHERE code = 'GEN'`,
      `TRUNCATE bible_book CASCADE`,
      `UPDATE bible_edition SET attribution = attribution`,
      `UPDATE bible_edition SET activated_at = now()`,
      `DELETE FROM bible_edition`,
      `TRUNCATE bible_edition CASCADE`,
      `INSERT INTO bible_verse (edition_id, book_code, chapter, verse, text, text_sha256)
         SELECT edition_id, book_code, 999, 1, text, text_sha256 FROM bible_verse LIMIT 1`,
      `UPDATE bible_superscription SET text = text`,
      `DELETE FROM bible_superscription`,
      `TRUNCATE bible_superscription`,
      `INSERT INTO bible_superscription
         (edition_id, book_code, chapter, before_verse, text, text_sha256)
         SELECT edition_id, book_code, chapter, verse, 'x', text_sha256
         FROM bible_verse WHERE book_code = 'GEN' LIMIT 1`,
      // An edition inserted already active would skip every activation check.
      `INSERT INTO bible_edition (code, name, abbreviation, language, canon, source_url,
         source_release, artifact_sha256, content_sha256, verse_count, superscription_count,
         license_status, attribution, rights_record, activated_at)
       VALUES ('insertactive', 'x', 'x', 'en', 'protestant', 'https://example.test/a.zip',
         '2099-01-01', repeat('a', 64), repeat('b', 64), 1, 0, 'public_domain', 'x', '{}', now())`,
    ]) {
      const error = await sqlFailure(sql);
      expect(error, sql).toMatchObject({ message: expect.stringMatching(IMMUTABLE) });
      expect((error as { parent?: { code?: string } }).parent?.code, sql).toBe('23000');
    }
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses to activate an edition whose rows do not match its counts or checksum', async () => {
    const before = await snapshot();
    const book = parsed.books[0];
    const verses = parsed.verses.filter((v) => v.bookCode === book?.code && v.chapter === 1);
    const attempt = async (
      overrides: Partial<{
        verseCount: number;
        superscriptionCount: number;
        contentSha256: string;
      }>,
    ) =>
      db
        .transaction(async (transaction) => {
          const edition = await BibleEdition.create(
            {
              code: 'activationtest',
              name: 'Activation test',
              abbreviation: 'AT',
              language: 'en',
              canon: 'protestant',
              sourceUrl: 'https://example.test/artifact.zip',
              sourceRelease: '2099-01-01',
              artifactSha256: sha256Hex('artifact'),
              contentSha256: overrides.contentSha256 ?? sha256Hex('wrong'),
              verseCount: overrides.verseCount ?? verses.length,
              superscriptionCount: overrides.superscriptionCount ?? 0,
              licenseStatus: 'public_domain',
              attribution: 'test',
              rightsRecord: {},
            },
            { transaction },
          );
          await BibleBook.create(
            { ...book, chapterCount: 1, editionId: edition.id },
            { transaction },
          );
          await BibleVerse.bulkCreate(
            verses.map((v) => ({ ...v, editionId: edition.id })),
            { transaction },
          );
          await edition.update({ activatedAt: new Date() }, { transaction });
          // Activated: roll back anyway, so nothing here is ever committed.
          throw new Error('activated');
        })
        .catch((error: Error) => error.message);

    expect(await attempt({ verseCount: verses.length + 1 })).toMatch(/verse count mismatch/);
    expect(await attempt({ superscriptionCount: 1 })).toMatch(/superscription count mismatch/);
    expect(await attempt({})).toMatch(/content checksum mismatch/);
    expect(
      await attempt({ contentSha256: contentSha256(verses, []) }),
      'the same rows with the right checksum activate (rolled back with the rest)',
    ).toBe('activated');
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses an edition created already active through the model', async () => {
    const before = await snapshot();
    const error = await BibleEdition.create({
      code: 'modelactive',
      name: 'Model active',
      abbreviation: 'MA',
      language: 'en',
      canon: 'protestant',
      sourceUrl: 'https://example.test/artifact.zip',
      sourceRelease: '2099-01-01',
      artifactSha256: sha256Hex('artifact'),
      contentSha256: sha256Hex('content'),
      verseCount: 1,
      superscriptionCount: 0,
      licenseStatus: 'public_domain',
      attribution: 'test',
      rightsRecord: {},
      activatedAt: new Date(),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: expect.stringMatching(IMMUTABLE) });
    expect((error as { parent?: { code?: string } }).parent?.code).toBe('23000');
    expect(await snapshot()).toStrictEqual(before);
  });

  it("checks activation against its own schema's tables whatever the caller's search_path", async () => {
    // The trigger functions pin search_path and schema-qualify every table, so lookalike tables
    // (or a lookalike checksum function) earlier on the caller's search_path are never consulted.
    // Attacked here: the real corpus in `public`. Everything runs in one transaction that is always
    // rolled back, the lookalike schema included.
    const rollback = new Error('rollback');
    const lookalikeVerses = [1, 2].map((verse) => ({
      bookCode: 'TST',
      chapter: 1,
      verse,
      text: 'x',
      textSha256: sha256Hex('x'),
    }));
    const outcome = await admin
      .transaction(async (transaction) => {
        // `bind` only when there are parameters: with it, Sequelize rewrites `$$` in the SQL.
        const run = (sql: string, bind?: unknown[]) =>
          admin.query(sql, { ...(bind ? { bind } : {}), transaction, type: QueryTypes.SELECT });
        await run(`CREATE SCHEMA corpus_lookalike`);
        for (const table of [
          'bible_edition',
          'bible_book',
          'bible_verse',
          'bible_superscription',
        ]) {
          await run(
            `CREATE TABLE corpus_lookalike.${table} (LIKE public.${table} INCLUDING DEFAULTS)`,
          );
        }
        await run(
          `CREATE FUNCTION corpus_lookalike.bible_edition_content_sha256(p_id uuid) RETURNS text
           LANGUAGE sql AS $f$ SELECT content_sha256 FROM public.bible_edition WHERE id = p_id $f$`,
        );
        // An incomplete edition in public: it declares two verses but has one.
        const [edition] = await run(
          `INSERT INTO public.bible_edition (code, name, abbreviation, language, canon, source_url,
             source_release, artifact_sha256, content_sha256, verse_count, superscription_count,
             license_status, attribution, rights_record)
           VALUES ('lookalike', 'x', 'x', 'en', 'protestant', 'https://example.test/a.zip',
             '2099-01-01', repeat('a', 64), $1, 2, 0, 'public_domain', 'x', '{}')
           RETURNING id`,
          [contentSha256(lookalikeVerses, [])],
        );
        const id = (edition as { id: string }).id;
        await run(
          `INSERT INTO public.bible_book (edition_id, code, sequence, name, abbreviation, chapter_count)
           VALUES ($1, 'TST', 1, 'x', 'x', 1)`,
          [id],
        );
        await run(
          `INSERT INTO public.bible_verse (edition_id, book_code, chapter, verse, text, text_sha256)
           VALUES ($1, 'TST', 1, 1, 'x', $2)`,
          [id, sha256Hex('x')],
        );
        // The lookalikes make the edition look complete to anything resolving names by path.
        await run(
          `INSERT INTO corpus_lookalike.bible_book SELECT * FROM public.bible_book WHERE edition_id = $1`,
          [id],
        );
        for (const v of lookalikeVerses) {
          await run(`INSERT INTO corpus_lookalike.bible_verse VALUES ($1, $2, $3, $4, $5, $6)`, [
            id,
            v.bookCode,
            v.chapter,
            v.verse,
            v.text,
            v.textSha256,
          ]);
        }
        await run(`SET LOCAL search_path = corpus_lookalike, public`);
        const [seen] = await run(
          `SELECT count(*)::int AS n FROM bible_verse WHERE edition_id = $1`,
          [id],
        );
        expect(seen, 'the attack premise: path lookups see the lookalike rows').toStrictEqual({
          n: 2,
        });
        await run(`UPDATE public.bible_edition SET activated_at = now() WHERE id = $1`, [id]);
        throw rollback;
      })
      .catch((e: unknown) => e);
    expect(outcome).not.toBe(rollback);
    expect(outcome).toMatchObject({
      message: expect.stringMatching(/bible edition activation refused: verse count mismatch/),
    });
    const [left] = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'corpus_lookalike'`,
      { type: QueryTypes.SELECT },
    );
    expect(left).toStrictEqual({ n: 0 });
  });

  it('logs counts and checksums only from the CLI, never Scripture text or references', async () => {
    const env = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      DATABASE_URL: new URL(
        `?options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`,
        url,
      ).toString(),
      OTP_PROVIDER: 'stytch',
      STYTCH_PROJECT_ID: 'project-test',
      STYTCH_SECRET: 'secret-test',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
      SESSION_COOKIE_SECURE: 'true',
    };
    const apiDir = path.resolve(__dirname, '..');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        path.join(apiDir, 'node_modules/.bin/tsx'),
        ['src/modules/bible-content/corpus/import-corpus.ts'],
        { cwd: apiDir, env: { ...process.env, ...env } },
      );
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });

    const lines = output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toStrictEqual([
      {
        level: 'log',
        pid: expect.any(Number),
        timestamp: expect.any(Number),
        message: 'corpus_import',
        context: 'Corpus',
        result: 'already_current',
        edition: 'engwebp',
        release: '2026-09-29',
        books: 66,
        chapters: 1189,
        verses: 31103,
        superscriptions: 138,
        artifactSha256: ENGWEBP_RELEASE.artifactSha256,
        contentSha256: ENGWEBP_RELEASE.contentSha256,
        durationMs: expect.any(Number),
      },
    ]);
    for (const book of parsed.books) expect(output).not.toContain(book.name);
  });
});
