import { spawn } from 'node:child_process';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import {
  CorpusValidationError,
  type ParsedCorpus,
  parseArtifact,
  sha256Hex,
} from '../src/modules/bible-content/corpus/corpus';
import {
  importCorpus,
  importParsedCorpus,
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
  artifactSha256: ENGWEBP_RELEASE.artifactSha256,
  contentSha256: ENGWEBP_RELEASE.contentSha256,
};

interface Snapshot {
  editions: unknown[];
  books: number;
  verses: number;
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
    const [counts] = await db.query<{ books: number; verses: number; content: string | null }>(
      `SELECT (SELECT count(*)::int FROM bible_book) AS books,
              (SELECT count(*)::int FROM bible_verse) AS verses,
              (SELECT bible_edition_content_sha256(id) FROM bible_edition LIMIT 1) AS content`,
      { type: QueryTypes.SELECT },
    );
    return {
      editions,
      books: counts?.books ?? -1,
      verses: counts?.verses ?? -1,
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
              bible_edition_content_sha256($1) AS content`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(shape).toStrictEqual({
      books: 66,
      chapters: 1189,
      verse_chapters: 1189,
      verses: 31103,
      empty: 5,
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
    const otherArtifact = { ...ENGWEBP_RELEASE, artifactSha256: sha256Hex('another artifact') };
    await expect(importParsedCorpus(db, parsed, otherArtifact)).rejects.toMatchObject({
      code: 'CORPUS_RELEASE_CONFLICT',
    });
    expect(await snapshot()).toStrictEqual(before);
  });

  it('writes nothing when validation fails, so the active release stays as it was', async () => {
    const before = await snapshot();
    const incomplete = structuredClone(parsed);
    incomplete.verses.splice(100, 1);
    const newRelease = { ...ENGWEBP_RELEASE, sourceRelease: '2099-01-01' };
    const error = await importParsedCorpus(db, incomplete, newRelease).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorpusValidationError);
    expect(error).toMatchObject({ code: 'CORPUS_BOUNDARIES' });
    expect(await snapshot()).toStrictEqual(before);
  });

  it('refuses every change to an activated edition at the database level', async () => {
    const before = await snapshot();
    for (const sql of [
      `UPDATE bible_verse SET text = text`,
      `UPDATE bible_verse SET text_sha256 = text_sha256 WHERE book_code = 'GEN'`,
      `DELETE FROM bible_verse WHERE book_code = 'REV'`,
      `TRUNCATE bible_verse`,
      `UPDATE bible_book SET name = name`,
      `DELETE FROM bible_book WHERE code = 'GEN'`,
      `TRUNCATE bible_book CASCADE`,
      `UPDATE bible_edition SET attribution = attribution`,
      `UPDATE bible_edition SET activated_at = now()`,
      `DELETE FROM bible_edition`,
      `TRUNCATE bible_edition CASCADE`,
      `INSERT INTO bible_verse (edition_id, book_code, chapter, verse, text, text_sha256)
         SELECT edition_id, book_code, 999, 1, text, text_sha256 FROM bible_verse LIMIT 1`,
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
    const attempt = async (overrides: Partial<{ verseCount: number; contentSha256: string }>) =>
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
        })
        .then(
          () => 'activated',
          (error: Error) => error.message,
        );

    expect(await attempt({ verseCount: verses.length + 1 })).toMatch(/verse count mismatch/);
    expect(await attempt({})).toMatch(/content checksum mismatch/);
    expect(await snapshot()).toStrictEqual(before);
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
        artifactSha256: ENGWEBP_RELEASE.artifactSha256,
        contentSha256: ENGWEBP_RELEASE.contentSha256,
        durationMs: expect.any(Number),
      },
    ]);
    for (const book of parsed.books) expect(output).not.toContain(book.name);
  });
});
