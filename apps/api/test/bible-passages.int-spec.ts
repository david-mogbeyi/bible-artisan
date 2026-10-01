import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  BiblePassageResponse,
  BibleReferenceResponse,
  BibleTranslationsResponse,
  ResolveReferenceResponse,
} from '@bible-artisan/contracts';
import request from 'supertest';
import { Op, QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

/**
 * GET /v1/bible/translations, GET /v1/bible/passages and POST /v1/bible/references (BIB-17) against the real imported WEB
 * corpus. No Scripture is typed: every expected verse, superscription and book name is read from
 * the stored rows at run time, so a passing test means the API returned those rows byte for byte.
 */

interface BookRow {
  code: string;
  name: string;
  chapterCount: number;
  sequence: number;
}

interface TextRow {
  bookCode: string;
  chapter: number;
  n: number;
  text: string;
}

const PATH = '/v1/bible/passages';
const TRANSLATIONS_PATH = '/v1/bible/translations';
const REFERENCES_PATH = '/v1/bible/references';

/**
 * Server latency per passage request, as NFR-PERF-001 states it: each request's `durationMs`
 * from its own access line. Collected only while `recording`.
 */
const serverMs: number[] = [];
let recording = false;
const ignore = (): void => undefined;
const accessRecorder = {
  log: (message: unknown, ...params: unknown[]): void => {
    if (!recording || message !== 'http_request') return;
    for (const p of params) {
      if (typeof p === 'object' && p !== null && 'durationMs' in p && 'route' in p) {
        if (p.route === PATH && typeof p.durationMs === 'number') serverMs.push(p.durationMs);
      }
    }
  },
  error: ignore,
  warn: ignore,
};

describe('Bible reader routes', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let edition: BibleEdition;
  let editionId: string;
  let alice: string;
  let bob: string;
  const userIds: string[] = [];
  let books: BookRow[];
  /** `BOOK chapter` -> verses in order, as stored. */
  let chapters: Map<string, { verse: number; text: string }[]>;
  /** `BOOK chapter` -> superscriptions in order, as stored. */
  let superscriptions: Map<string, { beforeVerse: number; text: string }[]>;

  const key = (bookCode: string, chapter: number): string => `${bookCode} ${chapter}`;
  const bookOf = (code: string): BookRow => {
    const book = books.find((b) => b.code === code);
    if (!book) throw new Error(`no book ${code}`);
    return book;
  };
  const lastVerseOf = (code: string, chapter: number): number =>
    chapters.get(key(code, chapter))?.length ?? 0;

  /** The stored whole-chapter reference row's id, read from the database (null if absent). */
  async function storedChapterId(code: string, chapter: number): Promise<string | null> {
    const [row] = await db.query<{ id: string }>(
      `SELECT id FROM scripture_reference
        WHERE edition_id = $1 AND book_code = $2 AND start_chapter = $3 AND start_verse = 1
          AND end_chapter = $3 AND end_verse = $4`,
      { bind: [editionId, code, chapter, lastVerseOf(code, chapter)], type: QueryTypes.SELECT },
    );
    return row?.id ?? null;
  }

  /** A neighbor link, with the id of the whole-chapter row the server upserted for it. */
  async function link(code: string, chapter: number) {
    const referenceId = await storedChapterId(code, chapter);
    if (!referenceId) throw new Error('neighbor reference row missing');
    return { bookCode: code, bookName: bookOf(code).name, chapter, referenceId };
  }
  type Link = Awaited<ReturnType<typeof link>>;

  const editionBody = () => ({
    id: editionId,
    name: edition.name,
    abbreviation: edition.abbreviation,
    attribution: edition.attribution,
    noticeUrl: String(ENGWEBP_RELEASE.rightsRecord.publisherNoticeUrl),
  });

  /** The whole expected body for a chapter, built from the stored rows. */
  function expectedChapter(
    code: string,
    chapter: number,
    neighbors: { previous: Link | null; next: Link | null },
    reference: BiblePassageResponse['reference'],
  ): BiblePassageResponse {
    const book = bookOf(code);
    return {
      edition: editionBody(),
      book: { code, name: book.name, chapterCount: book.chapterCount },
      chapter,
      verses: chapters.get(key(code, chapter)) ?? [],
      superscriptions: superscriptions.get(key(code, chapter)) ?? [],
      reference,
      ...neighbors,
    };
  }

  const passageAs = (cookie: string | undefined, query: Record<string, string>) => {
    const req = request(app.getHttpServer()).get(PATH).query(query);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const passage = (query: Record<string, string>) => passageAs(alice, query);

  const referencesAs = (cookie: string | undefined, body: Record<string, unknown>) => {
    const req = request(app.getHttpServer()).post(REFERENCES_PATH).send(body);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  /** The deterministic whole-chapter label: the bare name for a single-chapter book. */
  const chapterLabel = (code: string, chapter: number): string =>
    bookOf(code).chapterCount === 1 ? bookOf(code).name : `${bookOf(code).name} ${chapter}`;

  /** The whole-chapter reference body. */
  const wholeChapter = (code: string, chapter: number, id: string) => ({
    id,
    editionId,
    bookCode: code,
    startChapter: chapter,
    startVerse: 1,
    endChapter: chapter,
    endVerse: lastVerseOf(code, chapter),
    label: chapterLabel(code, chapter),
  });

  /** The whole-chapter reference id, as the reader's book/chapter picker gets it. */
  async function chapterId(code: string, chapter: number): Promise<string> {
    const res = await referencesAs(alice, { editionId, bookCode: code, chapter }).expect(200);
    return (res.body as BibleReferenceResponse).reference.id;
  }

  /** Opens a chapter by structure, as the reader does, then loads it. */
  async function chapterOf(
    code: string,
    chapter: number,
  ): Promise<{ body: BiblePassageResponse; id: string }> {
    const id = await chapterId(code, chapter);
    const res = await passage({ referenceId: id }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return { body: res.body as BiblePassageResponse, id };
  }

  /** The whole expected body of a chapter opened by `id`, its neighbors read from the database. */
  async function expectedWholeChapter(code: string, chapter: number, id: string) {
    const at = books.findIndex((b) => b.code === code);
    const before = books[at - 1];
    const after = books[at + 1];
    const book = bookOf(code);
    const previous =
      chapter > 1
        ? await link(code, chapter - 1)
        : before
          ? await link(before.code, before.chapterCount)
          : null;
    const next =
      chapter < book.chapterCount
        ? await link(code, chapter + 1)
        : after
          ? await link(after.code, 1)
          : null;
    return expectedChapter(code, chapter, { previous, next }, wholeChapter(code, chapter, id));
  }

  async function signedIn(): Promise<string> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return `ba_session=${token}`;
  }

  async function resolve(input: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/bible/resolve')
      .set('Cookie', alice)
      .send({ input, editionId })
      .expect(200);
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference.id;
  }

  beforeAll(async () => {
    app = await createTestApp(AppModule, { logger: accessRecorder });
    db = app.get<Database>(DATABASE);
    edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    editionId = edition.id;
    books = await db.query<BookRow>(
      `SELECT code, name, chapter_count AS "chapterCount", sequence
         FROM bible_book WHERE edition_id = $1 ORDER BY sequence`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    const verses = await db.query<TextRow>(
      `SELECT book_code AS "bookCode", chapter, verse AS n, text
         FROM bible_verse WHERE edition_id = $1 ORDER BY book_code, chapter, verse`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(verses).toHaveLength(31103);
    chapters = new Map();
    for (const v of verses) {
      const list = chapters.get(key(v.bookCode, v.chapter)) ?? [];
      list.push({ verse: v.n, text: v.text });
      chapters.set(key(v.bookCode, v.chapter), list);
    }
    const supers = await db.query<TextRow>(
      `SELECT book_code AS "bookCode", chapter, before_verse AS n, text
         FROM bible_superscription WHERE edition_id = $1 ORDER BY book_code, chapter, before_verse`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(supers).toHaveLength(138);
    superscriptions = new Map();
    for (const s of supers) {
      const list = superscriptions.get(key(s.bookCode, s.chapter)) ?? [];
      list.push({ beforeVerse: s.n, text: s.text });
      superscriptions.set(key(s.bookCode, s.chapter), list);
    }
    alice = await signedIn();
    bob = await signedIn();
  });

  afterAll(async () => {
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('GET /v1/bible/translations', () => {
    it('lists the active edition with its attribution and every book in canon order', async () => {
      const res = await request(app.getHttpServer())
        .get(TRANSLATIONS_PATH)
        .set('Cookie', alice)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const active = await BibleEdition.count({ where: { activatedAt: { [Op.ne]: null } } });
      expect(active).toBe(1);
      expect(res.body).toStrictEqual({
        translations: [
          {
            ...editionBody(),
            code: edition.code,
            language: edition.language,
            books: books.map((b) => ({ code: b.code, name: b.name, chapterCount: b.chapterCount })),
          },
        ],
      } satisfies BibleTranslationsResponse);
      expect((res.body as BibleTranslationsResponse).translations[0]?.books).toHaveLength(66);
    });

    it('answers 401 without a session and gives another user the same shared list', async () => {
      const anonymous = await request(app.getHttpServer()).get(TRANSLATIONS_PATH).expect(401);
      expect(anonymous.body).toStrictEqual(UNAUTHENTICATED);
      const mine = await request(app.getHttpServer())
        .get(TRANSLATIONS_PATH)
        .set('Cookie', alice)
        .expect(200);
      const theirs = await request(app.getHttpServer())
        .get(TRANSLATIONS_PATH)
        .set('Cookie', bob)
        .expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
    });
  });

  describe('GET /v1/bible/passages for whole chapters', () => {
    it('returns a chapter verbatim with its attribution and neighbors', async () => {
      const { body, id } = await chapterOf('ROM', 9);
      expect(body).toStrictEqual(await expectedWholeChapter('ROM', 9, id));
    });

    it('returns every chapter of the corpus byte for byte, chained by the neighbor reference ids in canon order from Genesis 1 to Revelation 22', async () => {
      let at: { bookCode: string; chapter: number; referenceId: string } | null = {
        bookCode: 'GEN',
        chapter: 1,
        referenceId: await chapterId('GEN', 1),
      };
      let previous: Link | null = null;
      let count = 0;
      let verseCount = 0;
      while (at) {
        // One request per chapter, by the id the previous chapter's `next` carried.
        const res = await passage({ referenceId: at.referenceId }).expect(200);
        const body = res.body as BiblePassageResponse;
        expect(body).toStrictEqual(
          expectedChapter(
            at.bookCode,
            at.chapter,
            { previous, next: body.next },
            wholeChapter(at.bookCode, at.chapter, at.referenceId),
          ),
        );
        previous = {
          bookCode: at.bookCode,
          bookName: bookOf(at.bookCode).name,
          chapter: at.chapter,
          referenceId: at.referenceId,
        };
        verseCount += body.verses.length;
        count += 1;
        at = body.next;
        if (count > 1189) throw new Error('chapter chain did not end');
      }
      expect(count).toBe(1189);
      expect(verseCount).toBe(31103);
      expect(previous).toStrictEqual(await link('REV', 22));
    }, 180_000);

    it('gives each neighbor the same shared reference as resolving that chapter by name', async () => {
      const { body } = await chapterOf('ROM', 9);
      expect(body.previous?.referenceId).toBe(await resolve(`${bookOf('ROM').name} 8`));
      expect(body.next?.referenceId).toBe(await resolve(`${bookOf('ROM').name} 10`));
      // A single-chapter book's whole chapter is its bare name.
      const { body: titus } = await chapterOf('TIT', 3);
      expect(titus.next?.referenceId).toBe(await resolve(bookOf('PHM').name));
    });

    it('has no chapter before Genesis 1 or after Revelation 22, and crosses book boundaries', async () => {
      for (const [code, chapter] of [
        ['GEN', 1],
        ['REV', 22],
        ['EXO', 1],
      ] as const) {
        const { body, id } = await chapterOf(code, chapter);
        expect(body).toStrictEqual(await expectedWholeChapter(code, chapter, id));
      }
      const genesis = (await chapterOf('GEN', 1)).body;
      expect([genesis.previous, genesis.next]).toStrictEqual([null, await link('GEN', 2)]);
      const revelation = (await chapterOf('REV', 22)).body;
      expect([revelation.previous, revelation.next]).toStrictEqual([await link('REV', 21), null]);
      const exodus = (await chapterOf('EXO', 1)).body;
      expect([exodus.previous, exodus.next]).toStrictEqual([
        await link('GEN', 50),
        await link('EXO', 2),
      ]);
    });

    it('links a single-chapter book to its neighboring books', async () => {
      const { body, id } = await chapterOf('JUD', 1);
      expect(body).toStrictEqual(
        expectedChapter(
          'JUD',
          1,
          { previous: await link('3JN', 1), next: await link('REV', 1) },
          wholeChapter('JUD', 1, id),
        ),
      );
      expect(bookOf('JUD').chapterCount).toBe(1);
    });

    it('returns Psalm titles and stanza headings as superscriptions, never inside verse text', async () => {
      const psalm3 = await chapterOf('PSA', 3);
      expect(psalm3.body).toStrictEqual(await expectedWholeChapter('PSA', 3, psalm3.id));
      // The stored rows themselves: one title before verse 1, never part of any verse.
      const title = superscriptions.get(key('PSA', 3)) ?? [];
      expect(title.map((t) => t.beforeVerse)).toStrictEqual([1]);
      const [only] = title;
      expect(only && only.text.length > 0).toBe(true);
      expect(psalm3.body.verses.some((v) => only !== undefined && v.text.includes(only.text))).toBe(
        false,
      );

      const psalm119 = await chapterOf('PSA', 119);
      expect(psalm119.body).toStrictEqual(await expectedWholeChapter('PSA', 119, psalm119.id));
      expect(lastVerseOf('PSA', 119)).toBe(176);
      expect((superscriptions.get(key('PSA', 119)) ?? []).map((t) => t.beforeVerse)).toStrictEqual(
        Array.from({ length: 22 }, (_, i) => i * 8 + 1),
      );
    });

    it('returns verses the edition gives no text for as empty, never dropped or filled', async () => {
      const empty = await db.query<{ bookCode: string; chapter: number; verse: number }>(
        `SELECT book_code AS "bookCode", chapter, verse FROM bible_verse
          WHERE edition_id = $1 AND text = '' ORDER BY book_code, chapter, verse`,
        { bind: [editionId], type: QueryTypes.SELECT },
      );
      expect(empty.map((v) => `${v.bookCode} ${v.chapter}:${v.verse}`)).toStrictEqual([
        'ACT 8:37',
        'ACT 15:34',
        'ACT 24:7',
        'LUK 17:36',
        'ROM 16:25',
      ]);
      for (const v of empty) {
        const { body, id } = await chapterOf(v.bookCode, v.chapter);
        // The whole body equals the stored rows, which hold the empty verse in its place.
        expect(body).toStrictEqual(await expectedWholeChapter(v.bookCode, v.chapter, id));
        expect(chapters.get(key(v.bookCode, v.chapter))?.[v.verse - 1]).toStrictEqual({
          verse: v.verse,
          text: '',
        });
      }
    });
  });

  describe('GET /v1/bible/passages by reference', () => {
    it('opens the chapter holding the reference start and returns the reference', async () => {
      const referenceId = await resolve('Rom 8:38-9:5');
      const res = await passage({ referenceId }).expect(200);
      expect(res.body).toStrictEqual(
        expectedChapter(
          'ROM',
          8,
          { previous: await link('ROM', 7), next: await link('ROM', 9) },
          {
            id: referenceId,
            editionId,
            bookCode: 'ROM',
            startChapter: 8,
            startVerse: 38,
            endChapter: 9,
            endVerse: 5,
            label: `${bookOf('ROM').name} 8:38–9:5`,
          },
        ),
      );
    });

    it('takes the edition from the reference; a matching editionId gives the same body', async () => {
      const referenceId = await resolve('Jude 3');
      const alone = await passage({ referenceId }).expect(200);
      const withEdition = await passage({ referenceId, editionId }).expect(200);
      expect(withEdition.body).toStrictEqual(alone.body);
      expect((alone.body as BiblePassageResponse).edition).toStrictEqual(editionBody());
    });

    it('answers 404 for an unknown reference or an editionId that is not the reference edition', async () => {
      const unknownReference = await passage({ referenceId: randomUUID() }).expect(404);
      expect(unknownReference.body).toStrictEqual(NOT_FOUND);
      const referenceId = await resolve('Jude 3');
      const otherEdition = await passage({ editionId: randomUUID(), referenceId }).expect(404);
      expect(otherEdition.body).toStrictEqual(NOT_FOUND);
    });
  });

  describe('POST /v1/bible/references', () => {
    it('gives a whole chapter the same shared reference as resolving it by name', async () => {
      const res = await referencesAs(alice, { editionId, bookCode: 'ROM', chapter: 9 }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const id = await resolve(`${bookOf('ROM').name} 9`);
      expect(res.body).toStrictEqual({ reference: wholeChapter('ROM', 9, id) });
    });

    it('gives a single-chapter book its whole chapter, the same as its bare name', async () => {
      const res = await referencesAs(alice, { editionId, bookCode: 'JUD', chapter: 1 }).expect(200);
      expect(res.body).toStrictEqual({
        reference: wholeChapter('JUD', 1, await resolve(bookOf('JUD').name)),
      });
    });

    it('gives one verse the same shared reference as resolving it by name', async () => {
      const res = await referencesAs(alice, {
        editionId,
        bookCode: 'PSA',
        chapter: 3,
        verse: 2,
      }).expect(200);
      const label = `${bookOf('PSA').name} 3:2`;
      expect(res.body).toStrictEqual({
        reference: {
          id: await resolve(label),
          editionId,
          bookCode: 'PSA',
          startChapter: 3,
          startVerse: 2,
          endChapter: 3,
          endVerse: 2,
          label,
        },
      });
    });

    it('refuses a book, chapter or verse the edition lacks with a specific 422 and writes nothing', async () => {
      const before = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM scripture_reference',
        { type: QueryTypes.SELECT },
      );
      const cases: [Record<string, unknown>, string, string][] = [
        [
          { bookCode: 'XYZ', chapter: 1 },
          'REFERENCE_UNKNOWN_BOOK',
          'No book in this translation matches that name',
        ],
        [
          { bookCode: 'JUD', chapter: 2 },
          'REFERENCE_CHAPTER_OUT_OF_RANGE',
          'That chapter does not exist in this book',
        ],
        [
          { bookCode: 'ROM', chapter: 9, verse: lastVerseOf('ROM', 9) + 1 },
          'REFERENCE_VERSE_OUT_OF_RANGE',
          'That verse does not exist in this chapter',
        ],
      ];
      for (const [body, code, message] of cases) {
        const res = await referencesAs(alice, { editionId, ...body }).expect(422);
        expect(res.body).toStrictEqual(envelope({ code, message }));
      }
      const after = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM scripture_reference',
        { type: QueryTypes.SELECT },
      );
      expect(after).toStrictEqual(before);
    });

    it('rejects malformed bodies with fixed messages, and an unknown edition with 404', async () => {
      const bad = await referencesAs(alice, { editionId, bookCode: 'Romans', chapter: '9' }).expect(
        400,
      );
      expect(bad.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: {
            bookCode: ['Enter a book code such as ROM'],
            chapter: ['Invalid input: expected number, received string'],
          },
        }),
      );
      const unknown = await referencesAs(alice, {
        editionId: randomUUID(),
        bookCode: 'ROM',
        chapter: 9,
      }).expect(404);
      expect(unknown.body).toStrictEqual(NOT_FOUND);
    });

    it('answers 401 without a session and gives another user the same shared reference', async () => {
      const body = { editionId, bookCode: 'ROM', chapter: 9 };
      const anonymous = await referencesAs(undefined, body).expect(401);
      expect(anonymous.body).toStrictEqual(UNAUTHENTICATED);
      const mine = await referencesAs(alice, body).expect(200);
      const theirs = await request(app.getHttpServer())
        .post('/v1/bible/references')
        .send(body)
        .set('Cookie', bob)
        .expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
    });
  });

  describe('validation and access', () => {
    it('rejects malformed parameters with fixed messages that never echo the input', async () => {
      const cases: [Record<string, string>, Record<string, string[]>][] = [
        [{}, { referenceId: ['Invalid input: expected string, received undefined'] }],
        [{ referenceId: 'rom-9-1' }, { referenceId: ['Invalid UUID'] }],
        [{ referenceId: randomUUID(), editionId: 'webp' }, { editionId: ['Invalid UUID'] }],
        // A book and chapter in the URL is not a supported form: only opaque IDs travel there.
        [
          { book: 'ROM', chapter: '9' },
          { referenceId: ['Invalid input: expected string, received undefined'] },
        ],
      ];
      for (const [query, fieldErrors] of cases) {
        const res = await passage(query).expect(400);
        expect(res.body).toStrictEqual(
          envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors }),
        );
      }
    });

    it('answers 401 without a session', async () => {
      const res = await passageAs(undefined, { referenceId: randomUUID() }).expect(401);
      expect(res.body).toStrictEqual(UNAUTHENTICATED);
    });

    it('gives another user the same shared chapter for the same request', async () => {
      const referenceId = await resolve('Rom 9:1');
      const mine = await passage({ referenceId }).expect(200);
      const theirs = await request(app.getHttpServer())
        .get('/v1/bible/passages')
        .query({ referenceId })
        .set('Cookie', bob)
        .expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
      expect((mine.body as BiblePassageResponse).verses.length).toBeGreaterThan(0);
    });
  });

  /**
   * NFR-PERF-001 (reader p95 ≤ 500 ms at 100 concurrent users) is a production target, confirmed
   * on deployment hardware by BIB-52. Here every request served alone must finish within 500 ms,
   * and the p95 of 100 concurrent requests is printed and held to `READER_P95_BUDGET_MS` (500 by
   * default; CI sets a larger value, since its runners are shared and noisy).
   */
  describe('performance (NFR-PERF-001)', () => {
    const SINGLE_REQUEST_BUDGET_MS = 500;
    const P95_BUDGET_MS = Number(process.env.READER_P95_BUDGET_MS ?? 500);
    const quantile = (sorted: number[], q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

    async function timed(queries: Record<string, string>[], concurrent: boolean) {
      serverMs.length = 0;
      recording = true;
      try {
        if (concurrent) await Promise.all(queries.map((q) => passage(q).expect(200)));
        else for (const q of queries) await passage(q).expect(200);
      } finally {
        recording = false;
      }
      expect(serverMs).toHaveLength(queries.length);
      return [...serverMs].sort((a, b) => a - b);
    }

    it('serves each chapter alone within 500 ms, and holds the concurrent p95 to its budget', async () => {
      expect(Number.isFinite(P95_BUDGET_MS) && P95_BUDGET_MS > 0).toBe(true);
      // The longest chapter, a chapter with superscriptions, a short one, and verse references.
      const inputs = ['Psalms 119', 'Psalms 3', 'Jude', 'Genesis 1', 'Rom 9:1'];
      const mix: Record<string, string>[] = [];
      for (const input of inputs) mix.push({ referenceId: await resolve(input) });
      await Promise.all(mix.map((q) => passage(q).expect(200))); // warm caches
      const alone = await timed([...mix, ...mix, ...mix], false);
      for (const ms of alone) expect(ms).toBeLessThanOrEqual(SINGLE_REQUEST_BUDGET_MS);
      const concurrent = await timed(
        Array.from({ length: 100 }, (_, i) => mix[i % mix.length] ?? {}),
        true,
      );
      const p95 = quantile(concurrent, 0.95);
      // Numbers only: no reference or text reaches the output.
      process.stdout.write(
        `[NFR-PERF-001] bible passage server latency: alone max ${alone.at(-1)} ms; ` +
          `100 concurrent p50 ${quantile(concurrent, 0.5)} ms, p95 ${p95} ms, ` +
          `max ${concurrent.at(-1)} ms (budget ${P95_BUDGET_MS} ms)\n`,
      );
      expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    }, 60_000);
  });
});
