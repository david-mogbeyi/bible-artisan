import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  type CreateStudyResponse,
  MAX_STUDY_TAGS,
  STUDY_EDIT_EMPTY,
  type StudyResponse,
  TAG_DUPLICATE,
  type UpdateStudyResponse,
  USER_TEXT_INVALID_CHARACTERS,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { StudyTag } from '../src/database/models/study-tag.model';
import { Study } from '../src/database/models/study.model';
import { Tag } from '../src/database/models/tag.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { ThreadService } from '../src/modules/thread/thread.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anyId: unknown = expect.stringMatching(UUID);

const STUDIES = '/v1/studies';
const studyPath = (studyId: string): string => `/v1/studies/${studyId}`;

/** Concurrent requests per race. Each holds a pooled connection (pool max 10, see database.ts). */
const RACERS = 4;

const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });
const conflict = (currentRevision: number) =>
  envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision });
const REVISION_MISSING = envelope({
  code: 'REVISION_MISSING',
  message: 'expectedRevision is required',
});
const QUESTION_NOT_FOUND = envelope({
  code: 'QUESTION_NOT_FOUND',
  message: 'That question is not part of this study',
});
const STUDY_UNCHANGED = envelope({
  code: 'STUDY_UNCHANGED',
  message: 'The study already has these values',
});
const KEY_REUSED = envelope({
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});

/**
 * BIB-20: `PATCH /v1/studies/:studyId` edits a study's title, description, main question, pin and
 * tags through `MutationService.execute`: revision-checked, idempotent, one StudyEvent per real
 * change in the same transaction. Real PostgreSQL throughout.
 */
describe('study editing (BIB-20)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  const userIds: string[] = [];

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return { user, cookie: `ba_session=${token}` };
  }

  async function createStudy(owner: Owner, body: object): Promise<CreateStudyResponse> {
    const res = await request(app.getHttpServer())
      .post(STUDIES)
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(201);
    return res.body as CreateStudyResponse;
  }

  /** Sends `PATCH /v1/studies/:studyId` and starts it immediately (supertest is otherwise lazy). */
  function patch(owner: Owner, studyId: string, body: unknown, key?: string): Promise<Response> {
    let req = request(app.getHttpServer()).patch(studyPath(studyId)).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body as object).then((res) => res);
  }

  async function read(owner: Owner, studyId: string): Promise<StudyResponse> {
    const res = await request(app.getHttpServer())
      .get(studyPath(studyId))
      .set('Cookie', owner.cookie)
      .expect(200);
    return res.body as StudyResponse;
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: e.payloadJson,
    }));
  }

  /** Every row an edit may write for this owner. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: ['id', 'title', 'description', 'pinnedAt', 'revision', 'contentRevision'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      nodes: await StudyNode.count({ where }),
      branches: await StudyBranch.count({ where }),
      events: await StudyEvent.count({ where }),
      tags: await Tag.count({ where }),
      studyTags: await StudyTag.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  async function lockWaiters(): Promise<number> {
    const [row] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'`,
      { type: QueryTypes.SELECT },
    );
    return row?.n ?? 0;
  }

  /**
   * Makes `count` requests genuinely overlap (the BIB-12 gate pattern): a gate transaction runs
   * `hold` (taking a lock every racer will need), the racers start, and once all `count` wait
   * inside PostgreSQL the gate rolls back and they contend as truly simultaneous requests would.
   */
  async function race(
    hold: (transaction: Awaited<ReturnType<Database['transaction']>>) => Promise<unknown>,
    starts: (() => Promise<Response>)[],
  ): Promise<Response[]> {
    const gate = await db.transaction();
    try {
      await hold(gate);
    } catch (error) {
      await gate.rollback();
      throw error;
    }
    const pending = starts.map((start) => start());
    try {
      const deadline = Date.now() + 10_000;
      while ((await lockWaiters()) < starts.length) {
        if (Date.now() > deadline) throw new Error('racers never all blocked on the gate');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await gate.rollback();
    }
    return Promise.all(pending);
  }

  const lockStudy =
    (studyId: string) => (transaction: Awaited<ReturnType<Database['transaction']>>) =>
      db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', { bind: [studyId], transaction });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Deleting a user cascades to sessions, receipts, tags and studies, and each study to its
    // nodes, branches, events and tag pairs.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('PATCH /v1/studies/:studyId', () => {
    it('renames, describes, pins and tags a study in one revision, with one event per change, the same after a reload', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const { studyId, questionNodeId, branchId } = created;

      const res = await patch(alice, studyId, {
        expectedRevision: 1,
        title: '  Conscience and the Spirit ',
        description: 'Romans first, then the epistles.',
        pinned: true,
        tags: ['  Holy  Spirit', 'conscience'],
      });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const question = { nodeId: questionNodeId, text: 'What is conscience?', status: 'open' };
      const tags = [
        { id: anyId, name: 'conscience' },
        { id: anyId, name: 'Holy Spirit' },
      ];
      expect(res.body).toStrictEqual({
        id: studyId,
        title: 'Conscience and the Spirit',
        description: 'Romans first, then the epistles.',
        lifecycle: 'active',
        pinned: true,
        revision: 2,
        contentRevision: 2,
        mainQuestion: question,
        originalQuestion: question,
        tags,
        branchId,
        lastEventSequence: '5',
      });
      const body = res.body as UpdateStudyResponse;
      const tagIds = body.tags.map((t) => t.id).sort();

      expect(await events(studyId)).toStrictEqual([
        { sequence: '1', eventType: 'study_created', payload: expect.any(Object) },
        { sequence: '2', eventType: 'study_renamed', payload: {} },
        { sequence: '3', eventType: 'study_description_changed', payload: { cleared: false } },
        { sequence: '4', eventType: 'study_pinned', payload: {} },
        {
          sequence: '5',
          eventType: 'study_tags_changed',
          payload: { addedTagIds: tagIds, removedTagIds: [] },
        },
      ]);

      const { lastEventSequence: _sequence, ...state } = body;
      expect(await read(alice, studyId)).toStrictEqual({
        ...state,
        startingReference: null,
        createdAt: expect.any(String),
      });
    });

    it('sets a new main question as a new Question node, keeping the original, and can make the original main again', async () => {
      const {
        studyId,
        questionNodeId: created,
        branchId,
      } = await createStudy(alice, {
        question: 'What is conscience?',
      });
      if (created === null) throw new Error('expected a question node');
      const questionNodeId = created;
      const original = { nodeId: questionNodeId, text: 'What is conscience?', status: 'open' };

      const changed = await patch(alice, studyId, {
        expectedRevision: 1,
        mainQuestion: { text: 'How does the Spirit bear witness?' },
      });
      expect(changed.status).toBe(200);
      const newNodeId = (changed.body as UpdateStudyResponse).mainQuestion?.nodeId;
      expect(changed.body).toStrictEqual({
        id: studyId,
        title: 'What is conscience?',
        description: null,
        lifecycle: 'active',
        pinned: false,
        revision: 2,
        contentRevision: 2,
        mainQuestion: { nodeId: anyId, text: 'How does the Spirit bear witness?', status: 'open' },
        originalQuestion: original,
        tags: [],
        branchId,
        lastEventSequence: '3',
      });
      expect(newNodeId).not.toBe(questionNodeId);
      // The original question node is untouched.
      const originalNode = await StudyNode.findByPk(questionNodeId, { rejectOnEmpty: true });
      expect([originalNode.title, originalNode.revision]).toStrictEqual(['What is conscience?', 1]);

      const restored = await patch(alice, studyId, {
        expectedRevision: 2,
        mainQuestion: { nodeId: questionNodeId.toUpperCase() },
      });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({
        revision: 3,
        contentRevision: 3,
        mainQuestion: original,
        originalQuestion: original,
      });
      expect((await events(studyId)).slice(1)).toStrictEqual([
        {
          sequence: '2',
          eventType: 'question_created',
          payload: { questionNodeId: newNodeId, branchId: null },
        },
        {
          sequence: '3',
          eventType: 'main_question_changed',
          payload: {
            fromNodeId: questionNodeId,
            toNodeId: newNodeId,
            originalQuestionNodeId: questionNodeId,
          },
        },
        {
          sequence: '4',
          eventType: 'main_question_changed',
          payload: {
            fromNodeId: newNodeId,
            toNodeId: questionNodeId,
            originalQuestionNodeId: questionNodeId,
          },
        },
      ]);
      const reloaded = await read(alice, studyId);
      expect([reloaded.mainQuestion, reloaded.originalQuestion]).toStrictEqual([
        original,
        original,
      ]);
    });

    it("gives a blank study's first main question the original role and the initial branch", async () => {
      const { studyId } = await createStudy(alice, { blank: true });
      const res = await patch(alice, studyId, {
        expectedRevision: 1,
        mainQuestion: { text: 'Where to start?' },
      });
      expect(res.status).toBe(200);
      const body = res.body as UpdateStudyResponse;
      const question = { nodeId: anyId, text: 'Where to start?', status: 'open' };
      expect(body).toMatchObject({ mainQuestion: question, originalQuestion: question });
      const branch = await StudyBranch.findOne({ where: { studyId }, rejectOnEmpty: true });
      expect(body.branchId).toBe(branch.id);
      expect(branch.rootNodeId).toBe(body.mainQuestion?.nodeId);
      expect((await events(studyId)).slice(1)).toStrictEqual([
        {
          sequence: '2',
          eventType: 'question_created',
          payload: { questionNodeId: body.mainQuestion?.nodeId, branchId: branch.id },
        },
        {
          sequence: '3',
          eventType: 'main_question_changed',
          payload: {
            fromNodeId: null,
            toNodeId: body.mainQuestion?.nodeId,
            originalQuestionNodeId: body.mainQuestion?.nodeId,
          },
        },
      ]);
    });

    it('moves the revision but not the content revision for pin and tag changes, and clears a description', async () => {
      const { studyId } = await createStudy(alice, { question: 'Why?' });
      const pinned = await patch(alice, studyId, { expectedRevision: 1, pinned: true });
      expect(pinned.body).toMatchObject({ revision: 2, contentRevision: 1, pinned: true });
      const tagged = await patch(alice, studyId, { expectedRevision: 2, tags: ['Grace'] });
      expect(tagged.body).toMatchObject({ revision: 3, contentRevision: 1 });
      const unpinned = await patch(alice, studyId, {
        expectedRevision: 3,
        pinned: false,
        tags: [],
      });
      expect(unpinned.body).toMatchObject({
        revision: 4,
        contentRevision: 1,
        pinned: false,
        tags: [],
      });
      const described = await patch(alice, studyId, { expectedRevision: 4, description: 'Notes' });
      expect(described.body).toMatchObject({ revision: 5, contentRevision: 2 });
      const cleared = await patch(alice, studyId, { expectedRevision: 5, description: null });
      expect(cleared.body).toMatchObject({ revision: 6, contentRevision: 3, description: null });

      const graceId = (tagged.body as UpdateStudyResponse).tags[0]?.id;
      expect((await events(studyId)).slice(1)).toStrictEqual([
        { sequence: '2', eventType: 'study_pinned', payload: {} },
        {
          sequence: '3',
          eventType: 'study_tags_changed',
          payload: { addedTagIds: [graceId], removedTagIds: [] },
        },
        { sequence: '4', eventType: 'study_unpinned', payload: {} },
        {
          sequence: '5',
          eventType: 'study_tags_changed',
          payload: { addedTagIds: [], removedTagIds: [graceId] },
        },
        { sequence: '6', eventType: 'study_description_changed', payload: { cleared: false } },
        { sequence: '7', eventType: 'study_description_changed', payload: { cleared: true } },
      ]);
      // The removed tag stays in the owner's vocabulary.
      expect(await Tag.count({ where: { id: graceId } })).toBe(1);
    });

    it("reuses the owner's tag by normalized name, keeps its display name, and never shares tags across owners", async () => {
      const first = await createStudy(alice, { question: 'One?' });
      const second = await createStudy(alice, { question: 'Two?' });
      const bobs = await createStudy(bob, { question: 'Three?' });

      const a = await patch(alice, first.studyId, { expectedRevision: 1, tags: ['Grace  Alone'] });
      const b = await patch(alice, second.studyId, { expectedRevision: 1, tags: [' grace alone'] });
      const c = await patch(bob, bobs.studyId, { expectedRevision: 1, tags: ['Grace Alone'] });
      const aliceTag = (a.body as UpdateStudyResponse).tags;
      expect(aliceTag).toStrictEqual([{ id: anyId, name: 'Grace Alone' }]);
      expect((b.body as UpdateStudyResponse).tags).toStrictEqual(aliceTag);
      const bobTag = (c.body as UpdateStudyResponse).tags;
      expect(bobTag).toStrictEqual([{ id: anyId, name: 'Grace Alone' }]);
      expect(bobTag[0]?.id).not.toBe(aliceTag[0]?.id);

      // Re-submitting the same key in another case is no change.
      const same = await patch(alice, first.studyId, {
        expectedRevision: 2,
        tags: ['GRACE ALONE'],
      });
      expect([same.status, same.body]).toStrictEqual([422, STUDY_UNCHANGED]);
    });

    it('answers 422 STUDY_UNCHANGED for an edit that changes nothing, writing nothing at all', async () => {
      const { studyId, questionNodeId } = await createStudy(alice, { question: 'Same?' });
      const before = await ownerRows(alice);
      const key = randomUUID();
      const res = await patch(
        alice,
        studyId,
        {
          expectedRevision: 1,
          title: 'Same?',
          pinned: false,
          tags: [],
          mainQuestion: { nodeId: questionNodeId },
        },
        key,
      );
      expect([res.status, res.body]).toStrictEqual([422, STUDY_UNCHANGED]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('answers 428 without expectedRevision and 409 with the current revision when it is stale, keeping the study as it was', async () => {
      const { studyId } = await createStudy(alice, { question: 'Stale?' });
      const missing = await patch(alice, studyId, { title: 'New' });
      expect([missing.status, missing.body]).toStrictEqual([428, REVISION_MISSING]);

      await patch(alice, studyId, { expectedRevision: 1, title: 'First' }).then((r) =>
        expect(r.status).toBe(200),
      );
      const before = await ownerRows(alice);
      // Stale wins over every other refusal the body would get.
      const stale = await patch(alice, studyId, {
        expectedRevision: 1,
        mainQuestion: { nodeId: randomUUID() },
      });
      expect([stale.status, stale.body]).toStrictEqual([409, conflict(2)]);
      expect(await ownerRows(alice)).toStrictEqual(before);
      expect((await read(alice, studyId)).title).toBe('First');
    });

    it('answers 400 for unknown keys, an empty edit, bad text and bad tags, without echoing input', async () => {
      const { studyId } = await createStudy(alice, { question: 'Valid?' });
      const before = await ownerRows(alice);
      const cases: [unknown, Record<string, string[]>][] = [
        [{ expectedRevision: 1 }, { _: [STUDY_EDIT_EMPTY] }],
        [
          { expectedRevision: 1, title: 'x', ownerId: bob.user.id },
          { _: ['Unrecognized key: "ownerId"'] },
        ],
        [
          { expectedRevision: 1, title: 'bad\u0000title' },
          { title: [USER_TEXT_INVALID_CHARACTERS] },
        ],
        [
          { expectedRevision: 1, title: 't'.repeat(201) },
          { title: ['Too big: expected string to have <=200 characters'] },
        ],
        [{ expectedRevision: 1, tags: ['Grace', 'grace'] }, { tags: [TAG_DUPLICATE] }],
        [
          {
            expectedRevision: 1,
            tags: Array.from({ length: MAX_STUDY_TAGS + 1 }, (_, i) => `t${i}`),
          },
          { tags: [`A study can have at most ${MAX_STUDY_TAGS} tags`] },
        ],
      ];
      for (const [body, fieldErrors] of cases) {
        const res = await patch(alice, studyId, body);
        expect([res.status, res.body]).toStrictEqual([400, invalid(fieldErrors)]);
      }
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it("answers the same 422 QUESTION_NOT_FOUND for another user's question, an absent node and another study's question", async () => {
      const { studyId } = await createStudy(alice, { question: 'Mine?' });
      const theirs = await createStudy(bob, { question: 'Theirs?' });
      const other = await createStudy(alice, { question: 'Other study?' });
      const before = await ownerRows(alice);
      for (const nodeId of [theirs.questionNodeId, randomUUID(), other.questionNodeId]) {
        const res = await patch(alice, studyId, { expectedRevision: 1, mainQuestion: { nodeId } });
        expect([res.status, res.body]).toStrictEqual([422, QUESTION_NOT_FOUND]);
      }
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('replays the original 200 for the same key and body, and answers 422 for the same key with another body', async () => {
      const { studyId } = await createStudy(alice, { question: 'Replay?' });
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Once', tags: ['Replay'] };
      const first = await patch(alice, studyId, body, key);
      expect(first.status).toBe(200);
      const after = await ownerRows(alice);

      const again = await patch(alice, studyId, body, key);
      expect([again.status, again.body]).toStrictEqual([200, first.body]);
      expect(again.headers['idempotent-replayed']).toBe('true');
      const reused = await patch(alice, studyId, { ...body, title: 'Twice' }, key);
      expect([reused.status, reused.body]).toStrictEqual([422, KEY_REUSED]);
      expect(await ownerRows(alice)).toStrictEqual(after);
    });

    it('rolls back the study, question node, tags and receipt when an event write fails; the same key then runs', async () => {
      const { studyId } = await createStudy(alice, { question: 'Atomic?' });
      const before = await ownerRows(alice);
      const key = randomUUID();
      const body = {
        expectedRevision: 1,
        title: 'Atomic',
        mainQuestion: { text: 'Still atomic?' },
        tags: ['Atomic'],
      };
      const thread = app.get(ThreadService);
      const original = thread.appendEvent.bind(thread);
      let calls = 0;
      vi.spyOn(thread, 'appendEvent').mockImplementation(async (lock, input) => {
        calls += 1;
        if (calls === 3) throw new Error('simulated failure');
        return original(lock, input);
      });
      const failed = await patch(alice, studyId, body, key);
      expect(failed.status).toBe(500);
      expect(await ownerRows(alice)).toStrictEqual(before);

      vi.restoreAllMocks();
      const retried = await patch(alice, studyId, body, key);
      expect(retried.status).toBe(200);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
    });

    it('answers 401 without a session', async () => {
      const { studyId } = await createStudy(alice, { question: 'Session?' });
      const res = await request(app.getHttpServer())
        .patch(studyPath(studyId))
        .send({ expectedRevision: 1, title: 'x' });
      expect([res.status, res.body]).toStrictEqual([401, UNAUTHENTICATED]);
    });

    it('PATCH /v1/studies/:studyId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      const { studyId } = await createStudy(alice, { question: 'Private?' });
      const before = await ownerRows(alice);
      const body = { expectedRevision: 1, title: 'Taken over', tags: ['Leak'] };
      const foreign = await request(app.getHttpServer())
        .patch(studyPath(studyId))
        .set('Cookie', bob.cookie)
        .send(body);
      const absent = await patch(bob, randomUUID(), body);
      const malformed = await patch(bob, 'not-a-study', body);
      expect([foreign.status, foreign.body]).toStrictEqual([404, NOT_FOUND]);
      expect([absent.status, absent.body]).toStrictEqual([404, NOT_FOUND]);
      expect([malformed.status, malformed.body]).toStrictEqual([404, NOT_FOUND]);
      expect(await ownerRows(alice)).toStrictEqual(before);
      expect(await Tag.count({ where: { ownerId: bob.user.id, normalizedName: 'leak' } })).toBe(0);
    });
  });

  describe('under real concurrency', () => {
    it('lets exactly one of N concurrent edits with the same expectedRevision win; the rest get 409', async () => {
      const { studyId } = await createStudy(alice, { question: 'Race?' });
      const results = await race(
        lockStudy(studyId),
        Array.from(
          { length: RACERS },
          (_, i) => () =>
            patch(alice, studyId, { expectedRevision: 1, title: `Title ${i}`, tags: [`t${i}`] }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toStrictEqual([200, ...Array<number>(RACERS - 1).fill(409)]);
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(loser.body).toStrictEqual(conflict(2));
      }
      const winner = results.find((r) => r.status === 200)?.body as UpdateStudyResponse;
      expect((await events(studyId)).map((e) => [e.sequence, e.eventType])).toStrictEqual([
        ['1', 'study_created'],
        ['2', 'study_renamed'],
        ['3', 'study_tags_changed'],
      ]);
      expect(await StudyTag.count({ where: { studyId } })).toBe(1);
      expect((await read(alice, studyId)).title).toBe(winner.title);
    });

    it('runs N concurrent identical edits with one key once and replays it to the rest', async () => {
      const { studyId } = await createStudy(alice, { question: 'Same key?' });
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Keyed', pinned: true };
      const results = await race(
        lockStudy(studyId),
        Array.from({ length: RACERS }, () => () => patch(alice, studyId, body, key)),
      );
      expect(results.map((r) => r.status)).toStrictEqual(Array<number>(RACERS).fill(200));
      // Every racer gets the one stored response (a replay's key order follows jsonb).
      for (const res of results) expect(res.body).toStrictEqual(results[0]?.body);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(
        RACERS - 1,
      );
      expect(await events(studyId)).toHaveLength(3);
    });

    it('converges two studies of one owner adding the same new tag at once on one tag row', async () => {
      const first = await createStudy(alice, { question: 'Tag one?' });
      const second = await createStudy(alice, { question: 'Tag two?' });
      const name = `Concurrent ${randomUUID()}`;
      const results = await race(
        (transaction) =>
          db.query(`INSERT INTO tag (owner_id, name, normalized_name) VALUES ($1, $2, lower($2))`, {
            bind: [alice.user.id, name],
            transaction,
          }),
        [
          () => patch(alice, first.studyId, { expectedRevision: 1, tags: [name] }),
          () => patch(alice, second.studyId, { expectedRevision: 1, tags: [name] }),
        ],
      );
      expect(results.map((r) => r.status)).toStrictEqual([200, 200]);
      const [a, b] = results.map((r) => (r.body as UpdateStudyResponse).tags);
      expect(a).toStrictEqual([{ id: anyId, name }]);
      expect(b).toStrictEqual(a);
      expect(
        await Tag.count({ where: { ownerId: alice.user.id, normalizedName: name.toLowerCase() } }),
      ).toBe(1);
    });
  });

  describe('database guards', () => {
    it('refuses to change an original question once set, while a study delete still cascades', async () => {
      const { studyId } = await createStudy(alice, { question: 'Original?' });
      const res = await patch(alice, studyId, {
        expectedRevision: 1,
        mainQuestion: { text: 'Another?' },
      });
      const otherId = (res.body as UpdateStudyResponse).mainQuestion?.nodeId;
      for (const value of [otherId, null]) {
        const error = await Study.update(
          { originalQuestionNodeId: value },
          { where: { id: studyId } },
        ).catch((e: unknown) => e);
        expect(error).toMatchObject({
          parent: expect.objectContaining({
            code: '23000',
            message: 'study original question is immutable',
          }),
        });
      }
      await Study.destroy({ where: { id: studyId } });
      expect(await StudyNode.count({ where: { studyId } })).toBe(0);
    });

    it("refuses a study_tag pairing one owner's study with another owner's tag (composite FK)", async () => {
      const { studyId } = await createStudy(alice, { question: 'FK?' });
      const bobTag = await Tag.create({
        ownerId: bob.user.id,
        name: 'Theirs',
        normalizedName: 'theirs',
      });
      for (const ownerId of [alice.user.id, bob.user.id]) {
        const error = await StudyTag.create({ studyId, ownerId, tagId: bobTag.id }).catch(
          (e: unknown) => e,
        );
        expect(error).toMatchObject({ parent: expect.objectContaining({ code: '23503' }) });
      }
    });
  });
});
