import type { Server } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { ScriptureReference } from '../src/database/models/scripture-reference.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { EXPLICIT_BOOK_ALIASES } from '../src/modules/bible-content/reference/book-index';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * POST /v1/bible/resolve (BIB-15) against the real imported WEB corpus. Expected bounds (chapter
 * counts, last verses) are read from the corpus tables, never typed. Whole response bodies are
 * asserted; the reference id is the only dynamic value and is pinned by comparing responses.
 */
describe('POST /v1/bible/resolve', () => {
  let app: INestApplication<Server>;
  let editionId: string;
  let alice: string;
  let bob: string;
  const userIds: string[] = [];
  const resolvePath = '/v1/bible/resolve';

  const resolveAs = (cookie: string | undefined, body: unknown) => {
    const req = request(app.getHttpServer())
      .post(resolvePath)
      .send(body as object);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const resolve = (input: string, cookie = alice) => resolveAs(cookie, { input, editionId });

  const lastVerse = async (bookCode: string, chapter: number): Promise<number> =>
    await BibleVerse.max<number, BibleVerse>('verse', { where: { editionId, bookCode, chapter } });
  const chapterCount = async (code: string): Promise<number> =>
    (await BibleBook.findOne({ where: { editionId, code }, rejectOnEmpty: true })).chapterCount;
  const referenceCount = (): Promise<number> => ScriptureReference.count({ where: { editionId } });

  const resolvedBody = (
    bookCode: string,
    startChapter: number,
    startVerse: number,
    endChapter: number,
    endVerse: number,
    label: string,
  ) => ({
    outcome: 'resolved',
    reference: {
      id: expect.stringMatching(UUID),
      editionId,
      bookCode,
      startChapter,
      startVerse,
      endChapter,
      endVerse,
      label,
    },
  });

  async function signedIn(): Promise<string> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const db = app.get<Database>(DATABASE);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return `ba_session=${token}`;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    editionId = edition.id;
    alice = await signedIn();
    bob = await signedIn();
  });

  afterAll(async () => {
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  it('resolves Romans 9:1 and Rom 9:1 to the same canonical reference', async () => {
    const full = await resolve('Romans 9:1').expect(200);
    expect(full.body).toStrictEqual(resolvedBody('ROM', 9, 1, 9, 1, 'Romans 9:1'));
    const short = await resolve('Rom 9:1').expect(200);
    expect(short.body).toStrictEqual(full.body);
    expect(short.headers['cache-control']).toBe('no-store');
  });

  it('gives another user the same shared reference for the same input', async () => {
    const mine = await resolveAs(alice, { input: 'Rom 8:28', editionId }).expect(200);
    const theirs = await request(app.getHttpServer())
      .post('/v1/bible/resolve')
      .set('Cookie', bob)
      .send({ input: 'Rom 8:28', editionId })
      .expect(200);
    expect(theirs.body).toStrictEqual(mine.body);
    expect(mine.body).toStrictEqual(resolvedBody('ROM', 8, 28, 8, 28, 'Romans 8:28'));
  });

  it('expands a whole chapter from the stored boundaries to the same id as its verse span', async () => {
    const last = await lastVerse('ROM', 9);
    const chapter = await resolve('Romans 9').expect(200);
    expect(chapter.body).toStrictEqual(resolvedBody('ROM', 9, 1, 9, last, 'Romans 9'));
    const span = await resolve(`ROM 9:1-${last}`).expect(200);
    expect(span.body).toStrictEqual(chapter.body);
  });

  it('resolves a cross-chapter range and persists exactly one row for it', async () => {
    const first = await resolve('Rom 8:38-9:5').expect(200);
    expect(first.body).toStrictEqual(resolvedBody('ROM', 8, 38, 9, 5, 'Romans 8:38–9:5'));
    const before = await referenceCount();
    const again = await Promise.all([
      resolve('Romans 8:38 \u2013 9:5'),
      resolve('rom 8:38-9:5'),
      resolve('ROM. 8:38\u20149:5'),
    ]);
    for (const res of again) expect(res.body).toStrictEqual(first.body);
    expect(await referenceCount()).toBe(before);
  });

  it('converges concurrent first resolves of a new range on one row', async () => {
    // Rows can never be deleted, so pick a Psalms range no earlier run (or test) has resolved:
    // random chapter, start after verse 1 and end after start (so the label is a plain verse
    // range), re-drawn until no row exists for it.
    const book = await BibleBook.findOne({
      where: { editionId, code: 'PSA' },
      rejectOnEmpty: true,
    });
    let range: { startChapter: number; startVerse: number; endVerse: number } | undefined;
    for (let attempt = 0; attempt < 100 && !range; attempt++) {
      const chapter = 1 + randomInt(book.chapterCount);
      const last = await lastVerse('PSA', chapter);
      if (last < 3) continue;
      const startVerse = 2 + randomInt(last - 2);
      const endVerse = startVerse + 1 + randomInt(last - startVerse);
      const exists = await ScriptureReference.count({
        where: {
          editionId,
          bookCode: 'PSA',
          startChapter: chapter,
          startVerse,
          endChapter: chapter,
          endVerse,
        },
      });
      if (exists === 0) range = { startChapter: chapter, startVerse, endVerse };
    }
    if (!range) throw new Error('no unresolved Psalms range found');
    const { startChapter, startVerse, endVerse } = range;
    const where = {
      editionId,
      bookCode: 'PSA',
      startChapter,
      startVerse,
      endChapter: startChapter,
      endVerse,
    };

    const input = `PSA ${startChapter}:${startVerse}-${endVerse}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => resolve(input)));
    for (const res of results) expect(res.status).toBe(200);
    const [first] = results;
    for (const res of results) expect(res.body).toStrictEqual(first?.body);
    expect(first?.body).toStrictEqual(
      resolvedBody(
        'PSA',
        startChapter,
        startVerse,
        startChapter,
        endVerse,
        `${book.name} ${startChapter}:${startVerse}–${endVerse}`,
      ),
    );
    const rows = await ScriptureReference.findAll({ where, attributes: ['id'] });
    expect(rows.map((row) => row.id)).toStrictEqual([
      (first?.body as { reference: { id: string } }).reference.id,
    ]);
  });

  it('resolves Unicode dashes, no-break spaces and full-width digits like ASCII', async () => {
    const ascii = await resolve('Rom 9:1-5').expect(200);
    expect(ascii.body).toStrictEqual(resolvedBody('ROM', 9, 1, 9, 5, 'Romans 9:1–5'));
    for (const input of [
      'Rom 9:1\u20135',
      'Rom 9:1\u20145',
      'Rom\u00A09:1\u00A0-\u00A05',
      'Rom \uFF19\uFF1A\uFF11-\uFF15',
    ]) {
      expect((await resolve(input).expect(200)).body).toStrictEqual(ascii.body);
    }
  });

  it('resolves Jude 3 to Jude 1:3 and refuses Jude 2:1', async () => {
    const res = await resolve('Jude 3').expect(200);
    expect(res.body).toStrictEqual(resolvedBody('JUD', 1, 3, 1, 3, 'Jude 1:3'));
    expect((await resolve('Philemon 1').expect(200)).body).toStrictEqual(
      resolvedBody('PHM', 1, 1, 1, 1, 'Philemon 1:1'),
    );
    const before = await referenceCount();
    const bad = await resolve('Jude 2:1').expect(422);
    expect(bad.body).toStrictEqual(
      envelope({
        code: 'REFERENCE_CHAPTER_OUT_OF_RANGE',
        message: 'That chapter does not exist in this book',
      }),
    );
    expect(await referenceCount()).toBe(before);
  });

  it('refuses invalid boundaries with a specific 422, no nearby verse and no new row', async () => {
    const chapters = await chapterCount('ROM');
    const last = await lastVerse('ROM', 9);
    const cases: [string, string, string][] = [
      [
        `Rom ${chapters + 1}:1`,
        'REFERENCE_CHAPTER_OUT_OF_RANGE',
        'That chapter does not exist in this book',
      ],
      [
        `Rom 9:${last + 1}`,
        'REFERENCE_VERSE_OUT_OF_RANGE',
        'That verse does not exist in this chapter',
      ],
      ['Rom 9:5-1', 'REFERENCE_RANGE_REVERSED', 'The passage ends before it starts'],
      ['Ps 1-150', 'REFERENCE_RANGE_TOO_LONG', 'A passage can span at most 200 verses'],
      ['Hezekiah 3:16', 'REFERENCE_UNKNOWN_BOOK', 'No book in this translation matches that name'],
      ['Rom 9:1,3', 'REFERENCE_MULTIPLE_PASSAGES', 'Enter one passage from one book at a time'],
      [
        'Rom 16:27-1 Cor 1:1',
        'REFERENCE_MULTIPLE_PASSAGES',
        'Enter one passage from one book at a time',
      ],
      ['Rom 9:', 'REFERENCE_MALFORMED', 'This is not a complete Bible reference'],
      // A verse-part suffix after the range dash is not a second (numbered) book.
      ['Rom 9:1-3a', 'REFERENCE_MALFORMED', 'This is not a complete Bible reference'],
      // Superscript footnote markers are never folded into the number (not Genesis 1:12 etc.).
      ['Gen 1:1\u00B2', 'REFERENCE_MALFORMED', 'This is not a complete Bible reference'],
      ['John 3:1\u2076', 'REFERENCE_MALFORMED', 'This is not a complete Bible reference'],
      ['Ps 1\u00B2', 'REFERENCE_MALFORMED', 'This is not a complete Bible reference'],
    ];
    const before = await referenceCount();
    for (const [input, code, message] of cases) {
      const res = await resolve(input).expect(422);
      expect(res.body).toStrictEqual(envelope({ code, message }));
    }
    expect(await referenceCount()).toBe(before);
  });

  it('lists every matching book in canon order for an ambiguous alias', async () => {
    const before = await referenceCount();
    const res = await resolve('Jud 3').expect(200);
    expect(res.body).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [
        { bookCode: 'JDG', bookName: 'Judges', input: 'Judges 3' },
        { bookCode: 'JUD', bookName: 'Jude', input: 'Jude 3' },
      ],
    });
    const phil = await resolve('Phil 1:1').expect(200);
    expect(phil.body).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [
        { bookCode: 'PHP', bookName: 'Philippians', input: 'Philippians 1:1' },
        { bookCode: 'PHM', bookName: 'Philemon', input: 'Philemon 1:1' },
      ],
    });
    // Only candidates whose chapter and verse exist are offered; one valid candidate is still
    // offered as a choice, never silently resolved (Philemon and Jude have one chapter).
    expect((await resolve('Phil 4:1').expect(200)).body).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [{ bookCode: 'PHP', bookName: 'Philippians', input: 'Philippians 4:1' }],
    });
    expect((await resolve('Jud 3:1').expect(200)).body).toStrictEqual({
      outcome: 'ambiguous',
      candidates: [{ bookCode: 'JDG', bookName: 'Judges', input: 'Judges 3:1' }],
    });
    expect(await referenceCount()).toBe(before);
    // Re-submitting a candidate resolves it.
    expect((await resolve('Judges 3').expect(200)).body).toStrictEqual(
      resolvedBody('JDG', 3, 1, 3, await lastVerse('JDG', 3), 'Judges 3'),
    );
  });

  it('returns not_reference for input that is not a complete reference shape', async () => {
    for (const input of ['bearing witness', 'love 1', 'so']) {
      expect((await resolve(input).expect(200)).body).toStrictEqual({ outcome: 'not_reference' });
    }
  });

  it('resolves each verse the edition stores with empty text', async () => {
    for (const { book, chapter, verse } of ENGWEBP_RELEASE.emptyVerses) {
      const res = await resolve(`${book} ${chapter}:${verse}`).expect(200);
      const name = (
        await BibleBook.findOne({ where: { editionId, code: book }, rejectOnEmpty: true })
      ).name;
      expect(res.body).toStrictEqual(
        resolvedBody(book, chapter, verse, chapter, verse, `${name} ${chapter}:${verse}`),
      );
    }
  });

  it('resolves every corpus book by name and every explicit alias to its book', async () => {
    const books = await BibleBook.findAll({ where: { editionId }, order: [['sequence', 'ASC']] });
    for (const book of books) {
      const label = `${book.name} 1:1`;
      const res = await resolve(`${book.name} 1:1`).expect(200);
      expect(res.body).toStrictEqual(resolvedBody(book.code, 1, 1, 1, 1, label));
      // The label round-trips to the same reference.
      expect((await resolve(label).expect(200)).body).toStrictEqual(res.body);
    }
    for (const [alias, code] of Object.entries(EXPLICIT_BOOK_ALIASES)) {
      const res = await resolve(`${alias} 1:1`).expect(200);
      const name = books.find((book) => book.code === code)?.name;
      expect(res.body).toStrictEqual(resolvedBody(code, 1, 1, 1, 1, `${name} 1:1`));
    }
  });

  it('rejects a missing or oversized input with 400 and never echoes it', async () => {
    const tooLong = `Romans 9:1 ${'x'.repeat(200)}`;
    const res = await resolveAs(alice, { input: tooLong, editionId }).expect(400);
    expect(res.body).toStrictEqual(
      envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { input: ['Too big: expected string to have <=200 characters'] },
      }),
    );
    const missing = await resolveAs(alice, { input: '   ', editionId: 'not-a-uuid' }).expect(400);
    expect(missing.body).toStrictEqual(
      envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: {
          input: ['Too small: expected string to have >=1 characters'],
          editionId: ['Invalid UUID'],
        },
      }),
    );
  });

  it('answers 404 for an edition that does not exist', async () => {
    const res = await resolveAs(alice, { input: 'Rom 9:1', editionId: randomUUID() }).expect(404);
    expect(res.body).toStrictEqual(NOT_FOUND);
  });

  it('answers 401 without a session', async () => {
    const res = await resolveAs(undefined, { input: 'Rom 9:1', editionId }).expect(401);
    expect(res.body).toStrictEqual(UNAUTHENTICATED);
  });
});
