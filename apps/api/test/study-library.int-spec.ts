import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  type CreateStudyResponse,
  LIBRARY_CURSOR_INVALID,
  type ResolveReferenceResponse,
  type ScriptureReference,
  type StudyListItem,
  type StudyListResponse,
  type StudyResponse,
  type StudySort,
  studySearchText,
  studySearchTokens,
  tagKey,
} from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { SessionService } from '../src/modules/identity/session.service';
import { libraryQuery } from '../src/modules/study/http/study-library';
import { createTestApp } from './app';
import { envelope, UNAUTHENTICATED } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

/** A study as the seed wrote it: what an independent oracle needs to order and filter. */
interface Seeded {
  id: string;
  title: string;
  description: string | null;
  pinned: boolean;
  lifecycle: 'active' | 'archived' | 'trashed';
  lastActivityAt: string;
  createdAt: string;
  tags: string[];
}

interface SeedSpec {
  title: string;
  description?: string | null;
  pinned?: boolean;
  lifecycle?: Seeded['lifecycle'];
  /** Microsecond UTC text, so ties and sub-millisecond differences are exact. */
  lastActivityAt?: string;
  createdAt?: string;
  tags?: string[];
}

const LIBRARY = '/v1/studies';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anyCursor: unknown = expect.stringMatching(/^[A-Za-z0-9_-]+$/);

const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });
const INVALID_CURSOR = invalid({ cursor: [LIBRARY_CURSOR_INVALID] });
const EMPTY_PAGE: StudyListResponse = { items: [], nextCursor: null };

/** Microsecond UTC timestamp `minutes` after a fixed base, plus `micros`. */
const at = (minutes: number, micros = 0): string => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0) + minutes * 60_000;
  return `${new Date(base).toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
};

/** The listing order: pinned first, then the sort within each group, ties by id. */
function oracle(rows: Seeded[], sort: StudySort): Seeded[] {
  const key = (row: Seeded): string =>
    sort === 'recent' ? row.lastActivityAt : sort === 'created' ? row.createdAt : row.title;
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ka = key(a);
    const kb = key(b);
    const byKey = ka < kb ? -1 : ka > kb ? 1 : 0;
    const byId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    const order = byKey !== 0 ? byKey : byId;
    return sort === 'title' ? order : -order;
  });
}

/** Independent search oracle: every folded word occurs in the title, description or a tag. */
function matches(row: Seeded, q: string): boolean {
  const haystacks = [tagKey(row.title), tagKey(row.description ?? ''), ...row.tags.map(tagKey)];
  return studySearchTokens(q).every((word) => haystacks.some((text) => text.includes(word)));
}

/**
 * BIB-21: `GET /v1/studies`, the owner's library. Real PostgreSQL throughout. Ordering, search
 * and pagination are checked against independent oracles over seeded studies; isolation against
 * a second user's studies, tags and cursors.
 */
describe('study library (BIB-21)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  const userIds: string[] = [];

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return { user, cookie: `ba_session=${token}` };
  }

  /**
   * Inserts studies (and their tags) directly, with chosen timestamps: the read side is under
   * test here; the write side (creation, editing) is exercised through the API further down.
   */
  async function seed(owner: Owner, specs: SeedSpec[]): Promise<Seeded[]> {
    const seeded: Seeded[] = [];
    for (const [index, spec] of specs.entries()) {
      const createdAt = spec.createdAt ?? at(index);
      const lastActivityAt = spec.lastActivityAt ?? createdAt;
      const description = spec.description ?? null;
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO study (owner_id, title, description, search_text, lifecycle, pinned_at,
                            created_at, updated_at, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz, $8::timestamptz)
         RETURNING id`,
        {
          bind: [
            owner.user.id,
            spec.title,
            description,
            studySearchText(spec.title, description),
            spec.lifecycle ?? 'active',
            spec.pinned ? createdAt : null,
            createdAt,
            lastActivityAt,
          ],
          type: QueryTypes.SELECT,
        },
      );
      if (!row) throw new Error('seed insert returned nothing');
      for (const name of spec.tags ?? []) {
        await db.query(
          `WITH t AS (
             INSERT INTO tag (owner_id, name, normalized_name) VALUES ($1, $2, $3)
             ON CONFLICT (owner_id, normalized_name) DO UPDATE SET name = tag.name
             RETURNING id)
           INSERT INTO study_tag (study_id, owner_id, tag_id) SELECT $4, $1, id FROM t`,
          { bind: [owner.user.id, name, tagKey(name), row.id] },
        );
      }
      seeded.push({
        id: row.id,
        title: spec.title,
        description,
        pinned: spec.pinned ?? false,
        lifecycle: spec.lifecycle ?? 'active',
        lastActivityAt,
        createdAt,
        tags: spec.tags ?? [],
      });
    }
    return seeded;
  }

  async function tagId(owner: Owner, name: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      'SELECT id FROM tag WHERE owner_id = $1 AND normalized_name = $2',
      { bind: [owner.user.id, tagKey(name)], type: QueryTypes.SELECT },
    );
    if (!row) throw new Error('no such tag');
    return row.id;
  }

  function list(owner: Owner, query: Record<string, string> = {}): Promise<Response> {
    return request(app.getHttpServer())
      .get(LIBRARY)
      .query(query)
      .set('Cookie', owner.cookie)
      .then((res) => res);
  }

  async function page(owner: Owner, query: Record<string, string> = {}) {
    const res = await list(owner, query);
    expect(res.status).toBe(200);
    return res.body as StudyListResponse;
  }

  /** Follows `nextCursor` to the end and returns every listed id, in order. */
  async function traverse(owner: Owner, query: Record<string, string>): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 200; pages += 1) {
      const body = await page(owner, cursor === null ? query : { ...query, cursor });
      ids.push(...body.items.map((item) => item.id));
      if (body.nextCursor === null) return ids;
      expect(body.items.length).toBe(Number(query.limit ?? 50));
      cursor = body.nextCursor;
    }
    throw new Error('pagination never ended');
  }

  async function storedActivity(studyId: string): Promise<string> {
    const [row] = await db.query<{ t: string }>(
      `SELECT to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS t
         FROM study WHERE id = $1`,
      { bind: [studyId], type: QueryTypes.SELECT },
    );
    if (!row) throw new Error('no such study');
    return row.t;
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    // Deleting a user cascades to sessions, receipts, tags and studies with their tag pairs.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('owner isolation', () => {
    it("GET /v1/studies lists only the signed-in user's studies: another user's studies, tag ids, search hits and cursors reveal nothing", async () => {
      const alice = await signedInUser();
      const bob = await signedInUser();
      const [aliceA] = await seed(alice, [
        { title: 'Conscience in Romans', tags: ['Witness'], pinned: true },
        { title: 'Grace alone' },
        { title: 'Faith and works' },
      ]);
      const [bobStudy] = await seed(bob, [{ title: 'Psalms of ascent' }]);
      if (!aliceA || !bobStudy) throw new Error('seed failed');
      const aliceTag = await tagId(alice, 'Witness');

      const own = await request(app.getHttpServer()).get('/v1/studies').set('Cookie', bob.cookie);
      expect(own.status).toBe(200);
      expect(own.body).toStrictEqual({
        items: [
          {
            id: bobStudy.id,
            title: 'Psalms of ascent',
            pinned: false,
            lifecycle: 'active',
            startingReference: null,
            tags: [],
            lastActivityAt: new Date(bobStudy.lastActivityAt).toISOString(),
            createdAt: new Date(bobStudy.createdAt).toISOString(),
          },
        ],
        nextCursor: null,
      });

      // Alice's tag id, words from her titles and tags, and her archived state: nothing.
      for (const query of [
        { tag: aliceTag },
        { q: 'conscience' },
        { q: 'witness' },
        { q: 'grace' },
        { state: 'archived' },
        { tag: aliceTag, q: 'conscience' },
      ]) {
        const res = await request(app.getHttpServer())
          .get('/v1/studies')
          .query(query)
          .set('Cookie', bob.cookie);
        expect(res.status).toBe(200);
        expect(res.body).toStrictEqual(EMPTY_PAGE);
      }

      // Alice's cursor (same filters) is refused for Bob, without listing anything.
      const alicePage = await page(alice, { limit: '1' });
      expect(alicePage.nextCursor).toStrictEqual(anyCursor);
      const replay = await request(app.getHttpServer())
        .get('/v1/studies')
        .query({ limit: '1', cursor: alicePage.nextCursor ?? '' })
        .set('Cookie', bob.cookie);
      expect(replay.status).toBe(400);
      expect(replay.body).toStrictEqual(INVALID_CURSOR);
    });

    it('answers 401 without a session', async () => {
      const res = await request(app.getHttpServer()).get(LIBRARY);
      expect(res.status).toBe(401);
      expect(res.body).toStrictEqual(UNAUTHENTICATED);
    });

    it('is private and uncacheable', async () => {
      const owner = await signedInUser();
      const res = await list(owner);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('items', () => {
    it('returns the card fields: starting passage, tags by normalized name, pin, activity', async () => {
      const owner = await signedInUser();
      const edition = await BibleEdition.findOne({
        where: {
          code: ENGWEBP_RELEASE.code,
          sourceRelease: ENGWEBP_RELEASE.sourceRelease,
          activatedAt: { [Op.ne]: null },
        },
        rejectOnEmpty: true,
      });
      const resolved = await request(app.getHttpServer())
        .post('/v1/bible/resolve')
        .set('Cookie', owner.cookie)
        .send({ input: 'Rom 9:1', editionId: edition.id })
        .expect(200);
      const outcome = resolved.body as ResolveReferenceResponse;
      if (outcome.outcome !== 'resolved') throw new Error('expected a resolved reference');
      const romans: ScriptureReference = outcome.reference;
      const created = await request(app.getHttpServer())
        .post(LIBRARY)
        .set('Cookie', owner.cookie)
        .send({ startingReferenceId: romans.id, question: 'What is conscience?' })
        .expect(201);
      const { studyId } = created.body as CreateStudyResponse;
      const edited = await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 1, pinned: true, tags: { add: ['zeal', 'Apostle'] } })
        .expect(200);
      expect((edited.body as StudyResponse).revision).toBe(2);
      const read = await request(app.getHttpServer())
        .get(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      const study = read.body as StudyResponse;

      const body = await page(owner);
      expect(body).toStrictEqual({
        items: [
          {
            id: studyId,
            title: 'Romans 9:1',
            pinned: true,
            lifecycle: 'active',
            startingReference: romans,
            tags: study.tags,
            lastActivityAt: expect.any(String) as unknown,
            createdAt: study.createdAt,
          },
        ],
        nextCursor: null,
      });
      expect(study.tags.map((tag) => tag.name)).toStrictEqual(['Apostle', 'zeal']);
    });
  });

  describe('ordering and pagination', () => {
    let owner: Owner;
    let rows: Seeded[];

    beforeAll(async () => {
      owner = await signedInUser();
      const specs: SeedSpec[] = [];
      const titles = ['apple', 'banana', 'cherry', 'cherry', 'damson', 'elder', 'fig', 'cherry'];
      for (let i = 0; i < 23; i += 1) {
        specs.push({
          title: titles[i % titles.length] ?? 'x',
          pinned: i % 5 === 0,
          // Ties at minute granularity, and neighbours that differ only in microseconds, so the
          // cursor must carry full precision and break ties by id.
          createdAt: at(i % 6, i % 3 === 0 ? 0 : 7),
          lastActivityAt: at(100 + (i % 4), i % 2 === 0 ? 1 : 999_999),
          tags: i % 2 === 0 ? ['even'] : ['odd'],
        });
      }
      specs.push({ title: 'archived one', lifecycle: 'archived' });
      specs.push({ title: 'trashed one', lifecycle: 'trashed' });
      rows = await seed(owner, specs);
    });

    const active = (): Seeded[] => rows.filter((row) => row.lifecycle === 'active');

    it.each(['recent', 'created', 'title'] as const)(
      'sort=%s lists pinned studies first, then the rest, each group in order; pages neither repeat nor skip',
      async (sort) => {
        const expected = oracle(active(), sort).map((row) => row.id);
        const all = await page(owner, { sort });
        expect(all.items.map((item) => item.id)).toStrictEqual(expected);
        expect(all.nextCursor).toBeNull();
        const firstUnpinned = all.items.findIndex((item) => !item.pinned);
        expect(all.items.slice(firstUnpinned).every((item) => !item.pinned)).toBe(true);
        for (const limit of ['1', '2', '5', '22', '23']) {
          expect(await traverse(owner, { sort, limit })).toStrictEqual(expected);
        }
      },
    );

    it('filters and searches across pages with the same order', async () => {
      const even = await tagId(owner, 'even');
      for (const sort of ['recent', 'created', 'title'] as const) {
        const tagged = oracle(
          active().filter((row) => row.tags.includes('even')),
          sort,
        ).map((row) => row.id);
        expect(await traverse(owner, { sort, tag: even, limit: '3' })).toStrictEqual(tagged);
        const searched = oracle(
          active().filter((row) => matches(row, 'CHERRY odd')),
          sort,
        ).map((row) => row.id);
        expect(searched.length).toBeGreaterThan(0);
        expect(await traverse(owner, { sort, q: 'CHERRY odd', limit: '2' })).toStrictEqual(
          searched,
        );
      }
    });

    it('lists archived studies only under state=archived, and trashed studies never', async () => {
      const archived = rows.filter((row) => row.lifecycle === 'archived').map((row) => row.id);
      expect((await page(owner, { state: 'archived' })).items.map((i) => i.id)).toStrictEqual(
        archived,
      );
      const listed = (await page(owner)).items.map((item) => item.title);
      expect(listed).not.toContain('archived one');
      expect(listed).not.toContain('trashed one');
      expect((await list(owner, { state: 'trashed' })).status).toBe(400);
    });

    it('refuses a tampered cursor, or one issued for other filters, sort or state', async () => {
      const first = await page(owner, { sort: 'recent', limit: '2' });
      const cursor = first.nextCursor ?? '';
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
      const forged = (value: unknown[]) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const tampered = [
        'not-a-cursor',
        forged([...decoded.slice(0, 4), randomUUID().toUpperCase().replace(/-/g, '')]),
        forged([decoded[0], 'x'.repeat(22), ...decoded.slice(2)]),
        forged([2, ...decoded.slice(1)]),
        forged([...decoded.slice(0, 3), '2026-01-01T00:00:00Z', decoded[4]]),
        forged([...decoded.slice(0, 2), 2, ...decoded.slice(3)]),
      ];
      for (const bad of tampered) {
        const res = await list(owner, { sort: 'recent', limit: '2', cursor: bad });
        expect(res.status).toBe(400);
        expect(res.body).toStrictEqual(INVALID_CURSOR);
      }
      const others: Record<string, string>[] = [
        { sort: 'created', limit: '2' },
        { sort: 'title', limit: '2' },
        { sort: 'recent', limit: '2', state: 'archived' },
        { sort: 'recent', limit: '2', q: 'cherry' },
        { sort: 'recent', limit: '2', tag: randomUUID() },
      ];
      for (const other of others) {
        const res = await list(owner, { ...other, cursor });
        expect(res.status).toBe(400);
        expect(res.body).toStrictEqual(INVALID_CURSOR);
      }
      // A different limit is the same listing: the cursor carries on.
      expect((await list(owner, { sort: 'recent', limit: '3', cursor })).status).toBe(200);
    });

    it('carries no title in a title cursor, and refuses one whose anchor study is gone', async () => {
      const temp = await signedInUser();
      await seed(temp, [{ title: 'alpha secret' }, { title: 'beta secret' }, { title: 'gamma' }]);
      const first = await page(temp, { sort: 'title', limit: '1' });
      const cursor = first.nextCursor ?? '';
      expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain('secret');
      expect((await page(temp, { sort: 'title', limit: '1', cursor })).items[0]?.title).toBe(
        'beta secret',
      );
      await Study.destroy({ where: { id: first.items[0]?.id ?? '' } });
      const res = await list(temp, { sort: 'title', limit: '1', cursor });
      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(INVALID_CURSOR);
    });

    it('bounds limit to 1..50 and refuses unknown or malformed parameters', async () => {
      for (const [query, fieldErrors] of [
        [{ limit: '0' }, { limit: ['Enter a whole number from 1 to 50'] }],
        [{ limit: '51' }, { limit: ['Enter a whole number from 1 to 50'] }],
        [{ sort: 'updated' }, { sort: expect.any(Array) as unknown }],
        [{ tag: 'nope' }, { tag: expect.any(Array) as unknown }],
        [{ ownerId: owner.user.id }, { _: expect.any(Array) as unknown }],
      ] as const) {
        const res = await list(owner, query);
        expect(res.status).toBe(400);
        expect(res.body).toStrictEqual(invalid(fieldErrors as Record<string, string[]>));
      }
      // Without a limit, a page holds the PRD's 50.
      const bulk = await signedInUser();
      await seed(
        bulk,
        Array.from({ length: 52 }, (_, i) => ({ title: `bulk ${i}` })),
      );
      const firstPage = await page(bulk);
      expect(firstPage.items.length).toBe(50);
      expect(firstPage.nextCursor).toStrictEqual(anyCursor);
      expect((await page(bulk, { cursor: firstPage.nextCursor ?? '' })).items.length).toBe(2);
    });
  });

  describe('search', () => {
    let owner: Owner;
    let rows: Seeded[];
    const fullWidth = (text: string): string =>
      text.replace(/[A-Z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0));

    beforeAll(async () => {
      owner = await signedInUser();
      rows = await seed(owner, [
        { title: 'Conscience study', description: 'Romans and Hebrews', tags: ['Witness'] },
        { title: 'Grace 100% sure' },
        { title: 'a_b notes' },
        { title: "O'Brien on Acts" },
        { title: 'c:* wild' },
        { title: 'back\\slash' },
        { title: 'Straße to Damascus' },
        { title: 'Plain study', description: 'Nothing special' },
        { title: 'Tagged only', tags: ['Grace alone'] },
      ]);
    });

    const titlesFor = async (q: string): Promise<string[]> =>
      (await page(owner, { q, sort: 'title' })).items.map((item) => item.title).sort();
    const expectedFor = (q: string): string[] =>
      rows
        .filter((row) => matches(row, q))
        .map((row) => row.title)
        .sort();

    it('matches every word in the title, description or a tag name, case-folded', async () => {
      expect(await titlesFor('conscience hebrews witness')).toStrictEqual(['Conscience study']);
      expect(await titlesFor('STUDY')).toStrictEqual(['Conscience study', 'Plain study']);
      expect(await titlesFor('grace')).toStrictEqual(['Grace 100% sure', 'Tagged only']);
      expect(await titlesFor('consc')).toStrictEqual(['Conscience study']);
      expect(await titlesFor('conscience special')).toStrictEqual([]);
      expect(await titlesFor('strasse')).toStrictEqual(['Straße to Damascus']);
      expect(await titlesFor(fullWidth('GRACE'))).toStrictEqual(expectedFor('grace'));
    });

    it('treats wildcards, operators, quotes and backslashes as literal characters', async () => {
      for (const q of ['%', '_', "'", ':*', '\\', '&|!', "%' OR 1=1 --", 'c:*', '100%']) {
        expect(await titlesFor(q)).toStrictEqual(expectedFor(q));
      }
      expect(await titlesFor('%')).toStrictEqual(['Grace 100% sure']);
      expect(await titlesFor('_')).toStrictEqual(['a_b notes']);
      expect(await titlesFor('\\')).toStrictEqual(['back\\slash']);
    });

    it('refuses an empty, invisible, over-long or over-wordy search without echoing it', async () => {
      for (const q of [
        '   ',
        String.fromCodePoint(0x200b),
        'x'.repeat(201),
        'a b c d e f g h i j k',
      ]) {
        const res = await list(owner, { q });
        expect(res.status).toBe(400);
        expect(Object.keys((res.body as { fieldErrors: object }).fieldErrors)).toStrictEqual(['q']);
        expect(JSON.stringify(res.body)).not.toContain(q.trim() || 'never');
      }
    });
  });

  describe('writes that feed the library', () => {
    it('a study starts with last activity at creation; each committed edit moves it in its transaction, reads and refused edits do not', async () => {
      const owner = await signedInUser();
      const created = await request(app.getHttpServer())
        .post(LIBRARY)
        .set('Cookie', owner.cookie)
        .send({ title: 'Activity probe', blank: true })
        .expect(201);
      const { studyId } = created.body as CreateStudyResponse;
      const [item] = (await page(owner)).items as [StudyListItem];
      // Written as the creating mutation ends: never before the study's creation time.
      expect(item.lastActivityAt >= item.createdAt).toBe(true);

      const before = await storedActivity(studyId);
      await request(app.getHttpServer())
        .get(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      await page(owner);
      expect(await storedActivity(studyId)).toBe(before);

      // Stale revision: 409, rolled back, activity unchanged.
      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 7, pinned: true })
        .expect(409);
      expect(await storedActivity(studyId)).toBe(before);

      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 1, pinned: true })
        .expect(200);
      const after = await storedActivity(studyId);
      expect(after > before).toBe(true);
      // Never earlier than the edit's own event (both on the application clock).
      const [event] = await db.query<{ t: string }>(
        `SELECT to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS t
           FROM study_event WHERE study_id = $1`,
        { bind: [studyId], type: QueryTypes.SELECT },
      );
      expect(after >= (event?.t ?? '~')).toBe(true);
      // A later edit moves it again; the 409 above shows a rolled-back edit never does.
      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 2, tags: { add: ['later'] } })
        .expect(200);
      expect((await storedActivity(studyId)) > after).toBe(true);
    });

    it('search follows title and description edits, never the old text', async () => {
      const owner = await signedInUser();
      const created = await request(app.getHttpServer())
        .post(LIBRARY)
        .set('Cookie', owner.cookie)
        .send({ title: 'Original wording', blank: true })
        .expect(201);
      const { studyId } = created.body as CreateStudyResponse;
      const ids = async (q: string) => (await page(owner, { q })).items.map((item) => item.id);
      expect(await ids('original')).toStrictEqual([studyId]);

      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 1, title: 'Renamed Study', description: 'About Philemon' })
        .expect(200);
      expect(await ids('original')).toStrictEqual([]);
      expect(await ids('renamed philemon')).toStrictEqual([studyId]);

      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${studyId}`)
        .set('Cookie', owner.cookie)
        .send({ expectedRevision: 2, description: null })
        .expect(200);
      expect(await ids('philemon')).toStrictEqual([]);
      const stored = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect(stored.searchText).toBe(studySearchText('Renamed Study', null));
    });
  });

  describe('performance', () => {
    it("uses the owner's library index for the default listing among 20,000 studies", async () => {
      // Ten owners with 2,000 studies each: the target owner holds about a tenth of the table, as
      // in a real deployment. (With only two owners, half the table matches the owner, and the
      // planner rightly prefers a sequential scan and sort.)
      const big = await signedInUser();
      const others = await Promise.all(Array.from({ length: 9 }, () => signedInUser()));
      for (const owner of [big, ...others]) {
        await db.query(
          `INSERT INTO study (owner_id, title, search_text, pinned_at, created_at, updated_at,
                              last_activity_at)
           SELECT $1, 'Study ' || g, 'study ' || g,
                  CASE WHEN g % 50 = 0 THEN now() END,
                  now() - g * interval '1 minute', now(), now() - g * interval '1 second'
             FROM generate_series(1, 2000) g`,
          { bind: [owner.user.id] },
        );
      }
      await db.query('ANALYZE study');
      const listing = {
        ownerId: big.user.id,
        state: 'active' as const,
        sort: 'recent' as const,
        tag: null,
        tokens: [],
      };
      const explain = async (query: { sql: string; bind: unknown[] }) =>
        JSON.stringify(
          await db.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, {
            bind: query.bind,
            type: QueryTypes.SELECT,
          }),
        );
      expect(await explain(libraryQuery(listing, null, 51))).toContain(
        'study_owner_library_recent_idx',
      );
      const first = await page(big, {});
      expect(first.items.length).toBe(50);
      // Every 50th study is pinned: 40 pinned first, then the most recent unpinned.
      expect(first.items.map((item) => item.pinned)).toStrictEqual([
        ...Array<boolean>(40).fill(true),
        ...Array<boolean>(10).fill(false),
      ]);
      const second = await page(big, { cursor: first.nextCursor ?? '' });
      expect(second.items.length).toBe(50);
      expect(UUID.test(second.items[0]?.id ?? '')).toBe(true);
    });
  });
});
