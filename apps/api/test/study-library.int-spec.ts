import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
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
  studyTitleSortKey,
  tagKey,
} from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../src/config/config.module';
import { cursorSecret, type Env } from '../src/config/env';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { SessionService } from '../src/modules/identity/session.service';
import {
  encodeLibraryCursor,
  type LibraryListing,
  libraryCursorKey,
} from '../src/modules/study/http/library-cursor';
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
  /** The tags as a list item shows them. */
  tagItems: { id: string; name: string }[];
  /** When a trashed seed is purged (its `deleted_at` + 30 days), else null (BIB-22). */
  purgeAt: string | null;
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
  /** A trashed seed's `deleted_at` (BIB-22); defaults to now, inside the recovery window. */
  deletedAt?: string;
}

const LIBRARY = '/v1/studies';
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

/** Code-point order, as PostgreSQL's `COLLATE "C"` compares UTF-8 bytes. */
const byCodePoint = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The listing order: pinned first (unless `pinnedFirst` is false), then the sort within each
 * group, ties by id. Titles order by their fold in code-point order, never a database collation.
 */
function oracle(rows: Seeded[], sort: StudySort, pinnedFirst = true): Seeded[] {
  return [...rows].sort((a, b) => {
    if (pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byKey =
      sort === 'title'
        ? byCodePoint(studyTitleSortKey(a.title), studyTitleSortKey(b.title))
        : byCodePoint(
            sort === 'recent' ? a.lastActivityAt : a.createdAt,
            sort === 'recent' ? b.lastActivityAt : b.createdAt,
          );
    const order = byKey !== 0 ? byKey : byCodePoint(a.id, b.id);
    return sort === 'title' ? order : -order;
  });
}

/** A seeded study as a list item (no starting passage: seeds carry none). */
const itemOf = (row: Seeded): StudyListItem => ({
  id: row.id,
  title: row.title,
  pinned: row.pinned,
  lifecycle: row.lifecycle,
  startingReference: null,
  tags: row.tagItems,
  lastActivityAt: new Date(row.lastActivityAt).toISOString(),
  createdAt: new Date(row.createdAt).toISOString(),
  purgeAt: row.purgeAt,
  // Seeds have no notes.
  matchedInNotes: false,
});

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
  /** The running app's cursor key (the fixed development secret in tests). */
  let cursorKey: Buffer;
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
      const lifecycle = spec.lifecycle ?? 'active';
      // Lifecycle dates agree with the state (BIB-22's CHECK).
      const deletedAt =
        lifecycle === 'trashed' ? (spec.deletedAt ?? new Date().toISOString()) : null;
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO study (owner_id, title, description, search_text, title_sort_key, lifecycle,
                            pinned_at, created_at, updated_at, last_activity_at, archived_at,
                            deleted_at)
         VALUES ($1, $2, $3, $4, $9, $5, $6, $7::timestamptz, $7::timestamptz, $8::timestamptz,
                 $10::timestamptz, $11::timestamptz)
         RETURNING id`,
        {
          bind: [
            owner.user.id,
            spec.title,
            description,
            studySearchText(spec.title, description),
            lifecycle,
            spec.pinned ? createdAt : null,
            createdAt,
            lastActivityAt,
            studyTitleSortKey(spec.title),
            lifecycle === 'archived' ? createdAt : null,
            deletedAt,
          ],
          type: QueryTypes.SELECT,
        },
      );
      if (!row) throw new Error('seed insert returned nothing');
      const tagItems: { id: string; name: string }[] = [];
      for (const name of spec.tags ?? []) {
        const [tag] = await db.query<{ id: string; name: string }>(
          `WITH t AS (
             INSERT INTO tag (owner_id, name, normalized_name) VALUES ($1, $2, $3)
             ON CONFLICT (owner_id, normalized_name) DO UPDATE SET name = tag.name
             RETURNING id, name)
           , st AS (INSERT INTO study_tag (study_id, owner_id, tag_id) SELECT $4, $1, id FROM t)
           SELECT id, name FROM t`,
          { bind: [owner.user.id, name, tagKey(name), row.id], type: QueryTypes.SELECT },
        );
        if (!tag) throw new Error('seed tag returned nothing');
        tagItems.push(tag);
      }
      // Seeds give a study at most one tag, or tags whose keys order the same in any collation.
      tagItems.sort((a, b) => byCodePoint(tagKey(a.name), tagKey(b.name)));
      seeded.push({
        id: row.id,
        title: spec.title,
        description,
        pinned: spec.pinned ?? false,
        lifecycle,
        lastActivityAt,
        createdAt,
        tags: spec.tags ?? [],
        tagItems,
        purgeAt:
          deletedAt === null
            ? null
            : new Date(Date.parse(deletedAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
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
    cursorKey = libraryCursorKey(cursorSecret(app.get<Env>(ENV)));
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
      expect(own.body).toStrictEqual({ items: [itemOf(bobStudy)], nextCursor: null });

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

      const stored = await Study.findByPk(studyId, { rejectOnEmpty: true });

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
            lastActivityAt: stored.lastActivityAt.toISOString(),
            createdAt: study.createdAt,
            purgeAt: null,
            matchedInNotes: false,
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
      // Trashed 30 days and one second ago: past its recovery window, so absent (BIB-22).
      specs.push({
        title: 'expired one',
        lifecycle: 'trashed',
        deletedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString(),
      });
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

    it('lists archived studies only under state=archived, and trashed ones inside their recovery window only under state=trashed (BIB-22)', async () => {
      const byTitle = (title: string): Seeded => {
        const row = rows.find((r) => r.title === title);
        if (!row) throw new Error('no such seed');
        return row;
      };
      expect(await page(owner, { state: 'archived' })).toStrictEqual({
        items: [itemOf(byTitle('archived one'))],
        nextCursor: null,
      });
      expect(await page(owner, { state: 'trashed', pinnedFirst: 'false' })).toStrictEqual({
        items: [itemOf(byTitle('trashed one'))],
        nextCursor: null,
      });
      expect(byTitle('trashed one').purgeAt).not.toBeNull();
      const listed = (await page(owner)).items.map((item) => item.title);
      expect(listed).not.toContain('archived one');
      expect(listed).not.toContain('trashed one');
      expect(listed).not.toContain('expired one');
    });

    it('pinnedFirst=false lists every study in the sort, pins ignored, across pages', async () => {
      for (const sort of ['recent', 'created', 'title'] as const) {
        const expected = oracle(active(), sort, false);
        // Pins really are interleaved, so this differs from the library's order.
        expect(expected.map((row) => row.id)).not.toStrictEqual(
          oracle(active(), sort).map((row) => row.id),
        );
        expect(await page(owner, { sort, pinnedFirst: 'false' })).toStrictEqual({
          items: expected.map(itemOf),
          nextCursor: null,
        });
        for (const limit of ['1', '3', '22']) {
          expect(await traverse(owner, { sort, pinnedFirst: 'false', limit })).toStrictEqual(
            expected.map((row) => row.id),
          );
        }
      }
      // Home's request: the three most recently active studies, whatever their pin.
      expect(await page(owner, { sort: 'recent', pinnedFirst: 'false', limit: '3' })).toStrictEqual(
        {
          items: oracle(active(), 'recent', false).slice(0, 3).map(itemOf),
          nextCursor: anyCursor,
        },
      );
    });

    it('refuses a tampered, truncated, foreign-key or legacy cursor, or one issued for other filters, sort, grouping or state', async () => {
      const first = await page(owner, { sort: 'recent', limit: '2' });
      const cursor = first.nextCursor ?? '';
      const bytes = Buffer.from(cursor, 'base64url');
      const flipped = (index: number): string => {
        const copy = Buffer.from(bytes);
        copy[index] = (copy[index] ?? 0) ^ 0x01;
        return copy.toString('base64url');
      };
      const second = first.items[1];
      if (!second) throw new Error('expected two studies');
      const listing: LibraryListing = {
        ownerId: owner.user.id,
        state: 'active',
        sort: 'recent',
        pinnedFirst: true,
        tag: null,
        tokens: [],
      };
      const position = {
        pinned: second.pinned,
        key: (await storedActivity(second.id)) + 'Z',
        id: second.id,
      };
      // The same position, sealed by this server, is accepted: the refusals below are the tamper.
      expect(
        (
          await list(owner, {
            sort: 'recent',
            limit: '2',
            cursor: encodeLibraryCursor(cursorKey, listing, position),
          })
        ).status,
      ).toBe(200);
      const tampered = [
        'not-a-cursor',
        flipped(0), // version
        flipped(5), // IV
        flipped(20), // ciphertext
        flipped(bytes.length - 1), // authentication tag
        bytes.subarray(0, bytes.length - 1).toString('base64url'),
        bytes.subarray(0, 20).toString('base64url'),
        // Sealed with another server's secret.
        encodeLibraryCursor(libraryCursorKey(randomBytes(32)), listing, position),
        // The pre-encryption format: readable JSON with a fingerprint.
        Buffer.from(JSON.stringify([1, 'x'.repeat(22), 0, position.key, position.id])).toString(
          'base64url',
        ),
      ];
      for (const bad of tampered) {
        const res = await list(owner, { sort: 'recent', limit: '2', cursor: bad });
        expect(res.status).toBe(400);
        expect(res.body).toStrictEqual(INVALID_CURSOR);
      }
      const others: Record<string, string>[] = [
        { sort: 'created', limit: '2' },
        { sort: 'title', limit: '2' },
        { sort: 'recent', limit: '2', pinnedFirst: 'false' },
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

    it('seals the cursor: no title, sort key or search word appears in it in any encoding', async () => {
      const temp = await signedInUser();
      await seed(temp, [
        { title: 'Zerubbabel Hiddenword one', description: 'Melchizedek priesthood' },
        { title: 'Zerubbabel Hiddenword two', description: 'Melchizedek priesthood' },
        { title: 'Zerubbabel Hiddenword three', description: 'Melchizedek priesthood' },
      ]);
      const first = await page(temp, { sort: 'title', limit: '1', q: 'melchizedek hiddenword' });
      const cursor = first.nextCursor ?? '';
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const raw = Buffer.from(cursor, 'base64url');
      const needles = [
        'Zerubbabel',
        'zerubbabel hiddenword one',
        studyTitleSortKey('Zerubbabel Hiddenword one'),
        'melchizedek',
        'hiddenword',
      ];
      for (const needle of needles) {
        for (const encoding of ['utf8', 'utf16le', 'latin1'] as const) {
          expect(raw.includes(Buffer.from(needle, encoding))).toBe(false);
          expect(raw.includes(Buffer.from(needle.toUpperCase(), encoding))).toBe(false);
        }
        const text = cursor.toLowerCase();
        expect(text.includes(needle.toLowerCase())).toBe(false);
        expect(text.includes(Buffer.from(needle).toString('hex'))).toBe(false);
        // Base64 at each of the three byte alignments (the stable middle of each encoding).
        for (const shift of [0, 1, 2]) {
          const padded = Buffer.concat([Buffer.alloc(shift), Buffer.from(needle)]);
          for (const form of ['base64', 'base64url'] as const) {
            const encoded = padded.toString(form).slice(4, -4);
            expect(cursor.includes(encoded)).toBe(false);
          }
        }
      }
      // Each issued cursor is freshly sealed: the same page twice gives different bytes.
      const again = await page(temp, { sort: 'title', limit: '1', q: 'melchizedek hiddenword' });
      expect(again.nextCursor).not.toBe(cursor);
      expect(
        await page(temp, { sort: 'title', limit: '1', q: 'melchizedek hiddenword', cursor }),
      ).toStrictEqual({
        items: [expect.objectContaining({ title: 'Zerubbabel Hiddenword three' })],
        nextCursor: anyCursor,
      });
    });

    it('keeps its place when the anchor study is renamed, unpinned or deleted between pages: no unchanged study is skipped or repeated', async () => {
      const temp = await signedInUser();
      const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
      const rows = await seed(
        temp,
        names.map((title, i) => ({ title, pinned: i === 1 })),
      );
      const byTitle = new Map(rows.map((row) => [row.title, row]));
      const rename = async (title: string, to: string) => {
        const study = byTitle.get(title);
        if (!study) throw new Error('no such study');
        const read = await request(app.getHttpServer())
          .get(`${LIBRARY}/${study.id}`)
          .set('Cookie', temp.cookie)
          .expect(200);
        await request(app.getHttpServer())
          .patch(`${LIBRARY}/${study.id}`)
          .set('Cookie', temp.cookie)
          .send({ expectedRevision: (read.body as StudyResponse).revision, title: to })
          .expect(200);
      };
      const rest = async (query: Record<string, string>, cursor: string): Promise<string[]> => {
        const ids: string[] = [];
        let next: string | null = cursor;
        while (next !== null) {
          const body = await page(temp, { ...query, cursor: next });
          ids.push(...body.items.map((item) => item.title));
          next = body.nextCursor;
        }
        return ids;
      };
      const query = { sort: 'title', pinnedFirst: 'false', limit: '2' };

      // Renamed past the cursor: the rest still starts at charlie, and the anchor shows up once
      // more at its new place (it changed; nothing that did not change repeats or goes missing).
      const one = await page(temp, query);
      expect(one.items.map((item) => item.title)).toStrictEqual(['alpha', 'bravo']);
      await rename('bravo', 'zulu');
      expect(await rest(query, one.nextCursor ?? '')).toStrictEqual([
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
        'zulu',
      ]);

      // Renamed before the cursor, then deleted: the next pages are unaffected.
      const two = await page(temp, { ...query, limit: '3' });
      expect(two.items.map((item) => item.title)).toStrictEqual(['alpha', 'charlie', 'delta']);
      await rename('delta', 'aardvark');
      expect(await rest({ ...query, limit: '3' }, two.nextCursor ?? '')).toStrictEqual([
        'echo',
        'foxtrot',
        'golf',
        'zulu',
      ]);
      const three = await page(temp, { ...query, limit: '3' });
      expect(three.items.map((item) => item.title)).toStrictEqual(['aardvark', 'alpha', 'charlie']);
      await Study.destroy({ where: { id: byTitle.get('charlie')?.id ?? '' } });
      expect(await rest({ ...query, limit: '3' }, three.nextCursor ?? '')).toStrictEqual([
        'echo',
        'foxtrot',
        'golf',
        'zulu',
      ]);

      // Pinned first: the anchor (the pinned "zulu", once "bravo") is unpinned between pages.
      const pinnedFirst = { sort: 'title', limit: '1' };
      const four = await page(temp, pinnedFirst);
      expect(four.items.map((item) => [item.title, item.pinned])).toStrictEqual([['zulu', true]]);
      const zulu = byTitle.get('bravo');
      const read = await request(app.getHttpServer())
        .get(`${LIBRARY}/${zulu?.id ?? ''}`)
        .set('Cookie', temp.cookie)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`${LIBRARY}/${zulu?.id ?? ''}`)
        .set('Cookie', temp.cookie)
        .send({ expectedRevision: (read.body as StudyResponse).revision, pinned: false })
        .expect(200);
      expect(await rest(pinnedFirst, four.nextCursor ?? '')).toStrictEqual([
        'aardvark',
        'alpha',
        'echo',
        'foxtrot',
        'golf',
        'zulu',
      ]);
    });

    it('orders titles by their case fold in code-point order, whatever the database collation', async () => {
      const temp = await signedInUser();
      const titles = [
        'Banana',
        'éclair',
        'apple',
        'Zeal',
        'ΑΣΤΗΡ',
        'ας',
        'Apple pie',
        'ab',
        'a-c',
        'fig',
      ];
      const rows = await seed(
        temp,
        titles.map((title) => ({ title })),
      );
      const expected = [
        'a-c',
        'ab',
        'apple',
        'Apple pie',
        'Banana',
        'fig',
        'Zeal',
        'éclair',
        'ας',
        'ΑΣΤΗΡ',
      ];
      expect(oracle(rows, 'title').map((row) => row.title)).toStrictEqual(expected);
      const body = await page(temp, { sort: 'title' });
      expect(body).toStrictEqual({ items: oracle(rows, 'title').map(itemOf), nextCursor: null });
      expect(await traverse(temp, { sort: 'title', limit: '3' })).toStrictEqual(
        oracle(rows, 'title').map((row) => row.id),
      );
      // The same order as an explicit COLLATE "C" over the stored fold, which no database
      // default collation can change; and the stored fold is the API's.
      const sql = await db.query<{ id: string; key: string }>(
        `SELECT id, title_sort_key AS key FROM study WHERE owner_id = $1
          ORDER BY title_sort_key COLLATE "C", id`,
        { bind: [temp.user.id], type: QueryTypes.SELECT },
      );
      expect(sql.map((row) => row.id)).toStrictEqual(body.items.map((item) => item.id));
      expect(sql.map((row) => row.key)).toStrictEqual(expected.map(studyTitleSortKey));
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
        { title: 'ΑΣΤΗΡ in Matthew' },
        { title: 'The name', tags: ['Ἰησοῦς'] },
      ]);
    });

    /**
     * Searches, asserts the whole response against the oracle (every matching study, as a list
     * item, in title order, one page), and returns the matched titles for readable spot checks.
     */
    const titlesFor = async (q: string): Promise<string[]> => {
      const body = await page(owner, { q, sort: 'title' });
      expect(body).toStrictEqual({
        items: oracle(
          rows.filter((row) => matches(row, q)),
          'title',
        ).map(itemOf),
        nextCursor: null,
      });
      return body.items.map((item) => item.title).sort();
    };
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

    it('folds Greek sigma the same in a fragment as in the word it is part of', async () => {
      expect(await titlesFor('ΑΣ')).toStrictEqual(['ΑΣΤΗΡ in Matthew']);
      expect(await titlesFor('ας')).toStrictEqual(['ΑΣΤΗΡ in Matthew']);
      expect(await titlesFor('αστηρ')).toStrictEqual(['ΑΣΤΗΡ in Matthew']);
      // A tag's final sigma, matched by a fragment ending mid-word and by the capitalized word.
      expect(await titlesFor('ΗΣΟῦΣ')).toStrictEqual(['The name']);
      expect(await titlesFor('ἸΗΣ')).toStrictEqual(['The name']);
      expect(await titlesFor('οῦς')).toStrictEqual(['The name']);
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
      expect([stored.searchText, stored.titleSortKey]).toStrictEqual([
        studySearchText('Renamed Study', null),
        studyTitleSortKey('Renamed Study'),
      ]);
      // Creation writes the title sort key too.
      const fresh = await request(app.getHttpServer())
        .post(LIBRARY)
        .set('Cookie', owner.cookie)
        .send({ title: 'ΛΌΓΟΣ First', blank: true })
        .expect(201);
      const freshStudy = await Study.findByPk((fresh.body as CreateStudyResponse).studyId, {
        rejectOnEmpty: true,
      });
      expect(freshStudy.titleSortKey).toBe('λόγοσ first');
    });

    it('one Greek tag, whatever its sigma form or case, across studies', async () => {
      const owner = await signedInUser();
      const tagged: string[] = [];
      for (const [title, tag] of [
        ['First', 'Λόγος'],
        ['Second', 'ΛΌΓΟΣ'],
        ['Third', 'λόγοσ'],
      ] as const) {
        const created = await request(app.getHttpServer())
          .post(LIBRARY)
          .set('Cookie', owner.cookie)
          .send({ title, blank: true })
          .expect(201);
        const { studyId } = created.body as CreateStudyResponse;
        await request(app.getHttpServer())
          .patch(`${LIBRARY}/${studyId}`)
          .set('Cookie', owner.cookie)
          .send({ expectedRevision: 1, tags: { add: [tag] } })
          .expect(200);
        tagged.push(studyId);
      }
      const tags = await db.query<{ name: string; key: string }>(
        `SELECT name, normalized_name AS key FROM tag WHERE owner_id = $1`,
        { bind: [owner.user.id], type: QueryTypes.SELECT },
      );
      // The first spelling names the one tag; its key holds no final sigma.
      expect(tags).toStrictEqual([{ name: 'Λόγος', key: 'λόγοσ' }]);
      const tagIdRow = await tagId(owner, 'λόγος');
      expect(
        (await page(owner, { tag: tagIdRow, sort: 'title' })).items.map((item) => item.id),
      ).toStrictEqual(tagged);
    });
  });

  describe('performance', () => {
    interface PlanNode {
      'Node Type': string;
      'Relation Name'?: string;
      'Index Name'?: string;
      'Index Cond'?: string;
      'Actual Rows'?: number;
      Plans?: PlanNode[];
    }
    /** Every plan node, depth first. */
    const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];
    const SORT_SQL: Record<StudySort, { value: string; order: string }> = {
      recent: {
        value: `to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        order: 'last_activity_at DESC, id DESC',
      },
      created: {
        value: `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        order: 'created_at DESC, id DESC',
      },
      title: { value: 'title_sort_key', order: 'title_sort_key COLLATE "C", id' },
    };

    let big: Owner;
    beforeAll(async () => {
      // One owner with 5,000 studies (every 50th pinned: 100 pinned) among nine others with 2,000
      // each, so deep pages exist and the target owner is a realistic share of the table.
      big = await signedInUser();
      const others = await Promise.all(Array.from({ length: 9 }, () => signedInUser()));
      for (const [owner, count] of [
        [big, 5000],
        ...others.map((other) => [other, 2000] as const),
      ] as const) {
        await db.query(
          `INSERT INTO study (owner_id, title, search_text, title_sort_key, pinned_at, created_at,
                              updated_at, last_activity_at)
           SELECT $1, 'Study ' || g, 'study ' || g, 'study ' || g,
                  CASE WHEN g % 50 = 0 THEN now() END,
                  now() - g * interval '1 minute', now(), now() - g * interval '1 second'
             FROM generate_series(1, $2::int) g`,
          { bind: [owner.user.id, count] },
        );
      }
      await db.query('ANALYZE study');
    }, 60_000);

    /** The owner's listing from `offset` on, by an independent OFFSET query over stored rows. */
    async function stored(sort: StudySort, offset: number, limit: number) {
      return db.query<{
        id: string;
        title: string;
        pinned: boolean;
        key: string;
        lastActivityAt: Date;
        createdAt: Date;
      }>(
        `SELECT id, title, is_pinned AS pinned, ${SORT_SQL[sort].value} AS key,
                last_activity_at AS "lastActivityAt", created_at AS "createdAt"
           FROM study WHERE owner_id = $1 AND lifecycle = 'active'
          ORDER BY is_pinned DESC, ${SORT_SQL[sort].order}
         OFFSET $2 LIMIT $3`,
        { bind: [big.user.id, offset, limit], type: QueryTypes.SELECT },
      );
    }

    it.each([
      ['recent', 4000],
      ['created', 4000],
      ['title', 4000],
      ['recent', 40],
      ['title', 40],
    ] as const)(
      'sort=%s seeks a deep page (after row %i) with an index range per pin group, reading only that page',
      async (sort, offset) => {
        const listing: LibraryListing = {
          ownerId: big.user.id,
          state: 'active',
          sort,
          pinnedFirst: true,
          tag: null,
          tokens: [],
        };
        const [anchor] = await stored(sort, offset - 1, 1);
        if (!anchor) throw new Error('no anchor row');
        const position = { pinned: anchor.pinned, key: anchor.key, id: anchor.id };
        // Row 40 is in the pinned group (100 pinned studies), row 4,000 deep in the unpinned one.
        expect(anchor.pinned).toBe(offset < 100);

        const query = libraryQuery(listing, position, 51);
        const [result] = await db.query<{
          'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }];
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, {
          bind: query.bind,
          type: QueryTypes.SELECT,
        });
        const plan = result?.['QUERY PLAN'][0];
        if (!plan) throw new Error('no plan');
        const nodes = nodesOf(plan.Plan);
        const indexed = nodes.filter((node) => node['Index Name'] !== undefined);
        expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan')).toStrictEqual([]);
        // Every read of the table goes through this sort's index...
        expect(new Set(indexed.map((node) => node['Index Name']))).toStrictEqual(
          new Set([`study_owner_library_${sort}_idx`]),
        );
        // ...and the cursor is the index range's start condition, not a filter over earlier rows.
        expect(indexed[0]?.['Index Cond']).toMatch(/is_pinned = (true|false)\) AND \(ROW\(/);
        if (anchor.pinned) {
          // Pinned cursor: the pinned group seeks from the cursor (an index or bitmap scan, as
          // the planner likes for a few dozen rows), the unpinned group starts at its top.
          expect(indexed).toHaveLength(2);
        } else {
          // Deep unpinned cursor: the finished pinned group is not read at all, and the one
          // ordered index scan stops after the page (plus one): no earlier row is read.
          expect(indexed.map((node) => [node['Node Type'], node['Actual Rows']])).toStrictEqual([
            ['Index Scan', 51],
          ]);
        }
        process.stdout.write(
          `[BIB-21] library sort=${sort} page after row ${offset}: ${plan['Execution Time'].toFixed(3)} ms\n`,
        );

        // Through the API, the same position gives exactly the next stored rows.
        const expected = await stored(sort, offset, 51);
        const body = await page(big, {
          sort,
          cursor: encodeLibraryCursor(cursorKey, listing, position),
        });
        expect(body).toStrictEqual({
          items: expected.slice(0, 50).map((row) => ({
            id: row.id,
            title: row.title,
            pinned: row.pinned,
            lifecycle: 'active',
            startingReference: null,
            tags: [],
            lastActivityAt: row.lastActivityAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            purgeAt: null,
            matchedInNotes: false,
          })),
          nextCursor: anyCursor,
        });
      },
    );

    it('lists the first page pinned first, as stored', async () => {
      const expected = await stored('recent', 0, 50);
      // Every 50th study is pinned: the 100 pinned fill the first page.
      expect(expected.every((row) => row.pinned)).toBe(true);
      expect(await page(big, {})).toStrictEqual({
        items: expected.map((row) => ({
          id: row.id,
          title: row.title,
          pinned: true,
          lifecycle: 'active',
          startingReference: null,
          tags: [],
          lastActivityAt: row.lastActivityAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          purgeAt: null,
          matchedInNotes: false,
        })),
        nextCursor: anyCursor,
      });
    });
  });
});
