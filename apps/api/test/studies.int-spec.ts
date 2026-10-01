import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  BLANK_STUDY_HAS_CONTENT,
  type CreateStudyResponse,
  type ResolveReferenceResponse,
  type ScriptureReference,
  STUDY_START_REQUIRED,
  USER_TEXT_INVALID_CHARACTERS,
} from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { ReferenceService } from '../src/modules/bible-content/reference/reference.service';
import { SessionService } from '../src/modules/identity/session.service';
import { ThreadService } from '../src/modules/thread/thread.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anyId: unknown = expect.stringMatching(UUID);

const STUDIES = '/v1/studies';
const studyPath = (studyId: string): string => `/v1/studies/${studyId}`;

/** Concurrent requests per race. Each holds a pooled connection (pool max 10, see database.ts). */
const RACERS = 6;

const REFERENCE_NOT_FOUND = envelope({
  code: 'REFERENCE_NOT_FOUND',
  message: 'That passage is not available in an active translation',
});
const KEY_REUSED = envelope({
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});
const INTERNAL_ERROR = envelope({
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred',
});
const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });

/**
 * BIB-19: `POST /v1/studies` creates the study, its root nodes, its initial branch and one
 * `study_created` event in one transaction through `MutationService.create`, idempotently per
 * (owner, Idempotency-Key); `GET /v1/studies/:studyId` reads it back. Real PostgreSQL throughout.
 */
describe('study creation and read (BIB-19)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  let romans: ScriptureReference;
  let jude: ScriptureReference;
  const userIds: string[] = [];

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return { user, cookie: `ba_session=${token}` };
  }

  async function resolve(owner: Owner, editionId: string, input: string) {
    const res = await request(app.getHttpServer())
      .post('/v1/bible/resolve')
      .set('Cookie', owner.cookie)
      .send({ input, editionId })
      .expect(200);
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  /** Sends `POST /v1/studies` and starts it immediately (supertest is otherwise lazy). */
  function create(owner: Owner, body: unknown, key?: string): Promise<Response> {
    let req = request(app.getHttpServer()).post(STUDIES).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body as object).then((res) => res);
  }

  function read(owner: Owner, studyId: string): Promise<Response> {
    return request(app.getHttpServer())
      .get(studyPath(studyId))
      .set('Cookie', owner.cookie)
      .then((res) => res);
  }

  /** Every row creation may have written for this owner: nothing else writes for them here. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.count({ where }),
      nodes: await StudyNode.count({ where }),
      branches: await StudyBranch.count({ where }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  /** The whole persisted shape of one study. */
  async function persisted(studyId: string) {
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
    const nodes = await StudyNode.findAll({ where: { studyId }, order: [['type', 'ASC']] });
    const branches = await StudyBranch.findAll({ where: { studyId } });
    const events = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return {
      study: {
        ownerId: study.ownerId,
        title: study.title,
        lifecycle: study.lifecycle,
        revision: study.revision,
        contentRevision: study.contentRevision,
        lastEventSequence: study.lastEventSequence,
        startingReferenceId: study.startingReferenceId,
        originalQuestionNodeId: study.originalQuestionNodeId,
        mainQuestionNodeId: study.mainQuestionNodeId,
      },
      nodes: nodes.map((n) => ({
        id: n.id,
        ownerId: n.ownerId,
        type: n.type,
        title: n.title,
        questionStatus: n.questionStatus,
        scriptureReferenceId: n.scriptureReferenceId,
        revision: n.revision,
      })),
      branches: branches.map((b) => ({ id: b.id, ownerId: b.ownerId, rootNodeId: b.rootNodeId })),
      events: events.map((e) => ({
        ownerId: e.ownerId,
        sequence: e.sequence,
        eventType: e.eventType,
        payloadJson: e.payloadJson,
      })),
    };
  }

  /** Backends of this database blocked on a lock: in this serial suite, only this file's racers. */
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
   * Makes `count` creations with one Idempotency-Key genuinely overlap (the BIB-12 gate pattern;
   * a new study has no row to gate on, so the gate holds the receipt key instead): a gate
   * transaction inserts the (owner, key) receipt without committing, every racer's claim blocks on
   * its unique-index entry, and once all `count` are waiting inside PostgreSQL the gate rolls
   * back. The racers then contend for the key exactly as truly simultaneous requests would.
   */
  async function raceOnKey(
    owner: Owner,
    key: string,
    count: number,
    start: () => Promise<Response>,
  ): Promise<Response[]> {
    const gate = await db.transaction();
    try {
      await db.query(
        `INSERT INTO mutation_receipt (owner_id, idempotency_key, route, request_hash, expires_at)
         VALUES ($1, $2, 'POST /v1/studies', repeat('0', 64), now() + interval '1 day')`,
        { bind: [owner.user.id, key], transaction: gate },
      );
    } catch (error) {
      await gate.rollback();
      throw error;
    }
    const pending = Array.from({ length: count }, start);
    try {
      const deadline = Date.now() + 10_000;
      while ((await lockWaiters()) < count) {
        if (Date.now() > deadline) throw new Error('racers never all blocked on the gate');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await gate.rollback();
    }
    return Promise.all(pending);
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    const edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    romans = await resolve(alice, edition.id, 'Rom 9:1');
    jude = await resolve(alice, edition.id, 'Jude 3');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Deleting a user cascades to their sessions, receipts and studies, and each study to its
    // nodes, branches and events (BIB-19).
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('POST /v1/studies', () => {
    it('creates the study, its Scripture and Question roots, the branch and one study_created event, answering after commit', async () => {
      const owner = await signedInUser();
      const res = await create(
        owner,
        { startingReferenceId: romans.id, question: '  What is conscience?  ' },
        randomUUID(),
      );

      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as CreateStudyResponse;
      expect(body).toStrictEqual({
        studyId: anyId,
        revision: 1,
        contentRevision: 1,
        rootNodeId: anyId,
        questionNodeId: anyId,
        branchId: anyId,
        lastEventSequence: '1',
      });
      // The 201 was sent after COMMIT: an independent connection already sees every row.
      expect(await persisted(body.studyId)).toStrictEqual({
        study: {
          ownerId: owner.user.id,
          title: 'Romans 9:1',
          lifecycle: 'active',
          revision: 1,
          contentRevision: 1,
          lastEventSequence: '1',
          startingReferenceId: romans.id,
          originalQuestionNodeId: body.questionNodeId,
          mainQuestionNodeId: body.questionNodeId,
        },
        nodes: [
          {
            id: body.questionNodeId,
            ownerId: owner.user.id,
            type: 'question',
            title: 'What is conscience?',
            questionStatus: 'open',
            scriptureReferenceId: null,
            revision: 1,
          },
          {
            id: body.rootNodeId,
            ownerId: owner.user.id,
            type: 'scripture',
            title: null,
            questionStatus: null,
            scriptureReferenceId: romans.id,
            revision: 1,
          },
        ],
        // PRD section 10: the question establishes the initial branch.
        branches: [{ id: body.branchId, ownerId: owner.user.id, rootNodeId: body.questionNodeId }],
        // Ids and the reference label only: never the question or title text.
        events: [
          {
            ownerId: owner.user.id,
            sequence: '1',
            eventType: 'study_created',
            payloadJson: {
              startingReferenceId: romans.id,
              startingReferenceLabel: 'Romans 9:1',
              scriptureNodeId: body.rootNodeId,
              questionNodeId: body.questionNodeId,
              branchId: body.branchId,
              blank: false,
            },
          },
        ],
      });
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 2,
        branches: 1,
        events: 1,
        receipts: 1,
      });
    });

    it('roots the branch at the passage and titles the study with its label when there is no question', async () => {
      const owner = await signedInUser();
      const res = await create(owner, { startingReferenceId: jude.id });
      expect(res.status).toBe(201);
      const body = res.body as CreateStudyResponse;
      expect(body).toStrictEqual({
        studyId: anyId,
        revision: 1,
        contentRevision: 1,
        rootNodeId: anyId,
        questionNodeId: null,
        branchId: anyId,
        lastEventSequence: '1',
      });
      const state = await persisted(body.studyId);
      expect(state.study).toMatchObject({
        title: jude.label,
        startingReferenceId: jude.id,
        originalQuestionNodeId: null,
        mainQuestionNodeId: null,
      });
      expect(state.branches).toStrictEqual([
        { id: body.branchId, ownerId: owner.user.id, rootNodeId: body.rootNodeId },
      ]);
      // No Idempotency-Key: nothing to replay, so no receipt.
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 1,
        branches: 1,
        events: 1,
        receipts: 0,
      });
    });

    it('titles a question-only study with the question, cut to 200 characters, and keeps a typed title over both', async () => {
      const owner = await signedInUser();
      const question = `${'Why does conscience accuse? '.repeat(10)}and more`;
      const questionOnly = await create(owner, { question });
      expect(questionOnly.status).toBe(201);
      const { studyId, questionNodeId, branchId } = questionOnly.body as CreateStudyResponse;
      const state = await persisted(studyId);
      expect(state.study.title).toBe(question.slice(0, 200).trimEnd());
      expect(state.study.startingReferenceId).toBeNull();
      expect(state.nodes).toStrictEqual([
        {
          id: questionNodeId,
          ownerId: owner.user.id,
          type: 'question',
          title: question,
          questionStatus: 'open',
          scriptureReferenceId: null,
          revision: 1,
        },
      ]);
      expect(state.branches).toStrictEqual([
        { id: branchId, ownerId: owner.user.id, rootNodeId: questionNodeId },
      ]);

      const titled = await create(owner, {
        title: ' Conscience and the Holy Spirit ',
        startingReferenceId: romans.id,
        question: 'What is conscience?',
      });
      const titledBody = titled.body as CreateStudyResponse;
      expect((await persisted(titledBody.studyId)).study.title).toBe(
        'Conscience and the Holy Spirit',
      );
    });

    it('creates an explicit blank study as "Untitled study" with no nodes, no branch, and one event', async () => {
      const owner = await signedInUser();
      const res = await create(owner, { blank: true }, randomUUID());
      expect(res.status).toBe(201);
      const body = res.body as CreateStudyResponse;
      expect(body).toStrictEqual({
        studyId: anyId,
        revision: 1,
        contentRevision: 1,
        rootNodeId: null,
        questionNodeId: null,
        branchId: null,
        lastEventSequence: '1',
      });
      expect(await persisted(body.studyId)).toStrictEqual({
        study: {
          ownerId: owner.user.id,
          title: 'Untitled study',
          lifecycle: 'active',
          revision: 1,
          contentRevision: 1,
          lastEventSequence: '1',
          startingReferenceId: null,
          originalQuestionNodeId: null,
          mainQuestionNodeId: null,
        },
        nodes: [],
        branches: [],
        events: [
          {
            ownerId: owner.user.id,
            sequence: '1',
            eventType: 'study_created',
            payloadJson: {
              startingReferenceId: null,
              startingReferenceLabel: null,
              scriptureNodeId: null,
              questionNodeId: null,
              branchId: null,
              blank: true,
            },
          },
        ],
      });
    });

    it.each([
      ['an empty body', {}, { _: [STUDY_START_REQUIRED] }],
      ['only a title', { title: 'Conscience' }, { _: [STUDY_START_REQUIRED] }],
      [
        'a blank study with a question',
        { blank: true, question: 'Why?' },
        { blank: [BLANK_STUDY_HAS_CONTENT] },
      ],
      [
        'a blank study with a passage',
        { blank: true, startingReferenceId: '00000000-0000-4000-8000-000000000001' },
        { blank: [BLANK_STUDY_HAS_CONTENT] },
      ],
      [
        'blank: false',
        { blank: false, question: 'Why?' },
        { blank: ['Invalid input: expected true'] },
      ],
      [
        'a 201-character title',
        { title: 't'.repeat(201), question: 'Why?' },
        { title: ['Too big: expected string to have <=200 characters'] },
      ],
      [
        'a 4,001-character question',
        { question: 'q'.repeat(4001) },
        { question: ['Too big: expected string to have <=4000 characters'] },
      ],
      [
        'a whitespace-only question',
        { question: '   ' },
        { question: ['Too small: expected string to have >=1 characters'] },
      ],
      // PostgreSQL text refuses U+0000; refused before the transaction, never a 500.
      [
        'a title holding U+0000',
        { title: 'Con\u0000science', question: 'Why?' },
        { title: [USER_TEXT_INVALID_CHARACTERS] },
      ],
      [
        'a question holding U+0000',
        { question: 'Why\u0000?' },
        { question: [USER_TEXT_INVALID_CHARACTERS] },
      ],
      [
        'a question holding a C0 control character',
        { question: 'Why\u001b[31m?' },
        { question: [USER_TEXT_INVALID_CHARACTERS] },
      ],
      [
        'a question holding a lone surrogate',
        { question: 'Why\ud83d?' },
        { question: [USER_TEXT_INVALID_CHARACTERS] },
      ],
      [
        'a malformed reference id',
        { startingReferenceId: 'rom-9-1' },
        { startingReferenceId: ['Invalid UUID'] },
      ],
      // The owner always comes from the session; a body can never name one.
      [
        'an ownerId',
        { question: 'Why?', ownerId: '00000000-0000-4000-8000-000000000001' },
        { _: ['Unrecognized key: "ownerId"'] },
      ],
      // Creation has no revision to compare against: a revision is refused, never required (428).
      [
        'an expectedRevision',
        { question: 'Why?', expectedRevision: 1 },
        { _: ['Unrecognized key: "expectedRevision"'] },
      ],
    ])('answers 400 for %s and writes nothing', async (_, body, fieldErrors) => {
      const owner = await signedInUser();
      const res = await create(owner, body, randomUUID());
      expect([res.status, res.body]).toStrictEqual([400, invalid(fieldErrors)]);
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 0,
        nodes: 0,
        branches: 0,
        events: 0,
        receipts: 0,
      });
    });

    it('answers 400 for an Idempotency-Key that is not a UUID, without echoing it', async () => {
      const owner = await signedInUser();
      const res = await create(owner, { question: 'Why?' }, 'not-a-key');
      expect([res.status, res.body]).toStrictEqual([
        400,
        invalid({ 'Idempotency-Key': ['Must be a UUID'] }),
      ]);
      expect((await ownerRows(owner)).studies).toBe(0);
    });

    it('answers 422 REFERENCE_NOT_FOUND for an unknown reference and writes nothing; the same key then works with a valid body', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      const res = await create(owner, { startingReferenceId: randomUUID(), question: 'Why?' }, key);
      expect([res.status, res.body]).toStrictEqual([422, REFERENCE_NOT_FOUND]);
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 0,
        nodes: 0,
        branches: 0,
        events: 0,
        receipts: 0,
      });

      const retried = await create(owner, { startingReferenceId: romans.id }, key);
      expect(retried.status).toBe(201);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
    });

    it('answers 422 REFERENCE_NOT_FOUND when the reference is not in an active edition, writing nothing', async () => {
      const owner = await signedInUser();
      // `storedReference` answers NotFoundError for a reference whose edition is not active
      // (BIB-17). Activated editions can never be deactivated or deleted (BIB-14 triggers), so a
      // real inactive edition cannot be left in the shared test database; stand it in here.
      const references = app.get(ReferenceService);
      vi.spyOn(references, 'storedReference').mockRejectedValueOnce(new NotFoundError());
      const res = await create(owner, { startingReferenceId: romans.id }, randomUUID());
      expect([res.status, res.body]).toStrictEqual([422, REFERENCE_NOT_FOUND]);
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 0,
        nodes: 0,
        branches: 0,
        events: 0,
        receipts: 0,
      });
    });

    it('rolls back the study, nodes, branch and receipt when the work fails after writing them; a retry with the same key runs', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      const body = { startingReferenceId: romans.id, question: 'What is conscience?' };
      // The event is the last write of the work: fail there, after study, nodes and branch exist.
      vi.spyOn(app.get(ThreadService), 'appendEvent').mockRejectedValueOnce(
        new Error('event write failed'),
      );
      const failed = await create(owner, body, key);
      expect([failed.status, failed.body]).toStrictEqual([500, INTERNAL_ERROR]);
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 0,
        nodes: 0,
        branches: 0,
        events: 0,
        receipts: 0,
      });

      const retried = await create(owner, body, key);
      expect(retried.status).toBe(201);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 2,
        branches: 1,
        events: 1,
        receipts: 1,
      });
    });

    it('replays the original 201 for the same key and body, creating no second study', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      const first = await create(owner, { startingReferenceId: romans.id, question: 'Why?' }, key);
      // Member order does not change the request.
      const second = await create(owner, { question: 'Why?', startingReferenceId: romans.id }, key);
      expect(first.status).toBe(201);
      expect([second.status, second.body]).toStrictEqual([201, first.body]);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 2,
        branches: 1,
        events: 1,
        receipts: 1,
      });
    });

    it('answers 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body, writing nothing more', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      expect((await create(owner, { question: 'Why?' }, key)).status).toBe(201);
      const reused = await create(owner, { question: 'Why not?' }, key);
      expect([reused.status, reused.body]).toStrictEqual([422, KEY_REUSED]);
      expect((await ownerRows(owner)).studies).toBe(1);
    });

    it('POST /v1/studies keeps Idempotency-Keys per owner: another user reusing a key gets their own study', async () => {
      const key = randomUUID();
      const body = { question: 'What is conscience?' };
      const owner = await signedInUser();
      const other = await signedInUser();
      const mine = await create(owner, body, key);
      const theirs = await request(app.getHttpServer())
        .post(STUDIES)
        .set('Cookie', other.cookie)
        .set('Idempotency-Key', key)
        .send(body);
      expect(theirs.status).toBe(201);
      expect(theirs.headers['idempotent-replayed']).toBeUndefined();
      expect(theirs.body).toStrictEqual({
        studyId: anyId,
        revision: 1,
        contentRevision: 1,
        rootNodeId: null,
        questionNodeId: anyId,
        branchId: anyId,
        lastEventSequence: '1',
      });
      const mineBody = mine.body as CreateStudyResponse;
      const theirsBody = theirs.body as CreateStudyResponse;
      expect(theirsBody.studyId).not.toBe(mineBody.studyId);
      expect((await persisted(theirsBody.studyId)).study.ownerId).toBe(other.user.id);
      expect((await ownerRows(owner)).studies).toBe(1);
      expect((await ownerRows(other)).studies).toBe(1);
    });

    it('answers 401 without a session and writes nothing', async () => {
      const before = await Study.count();
      const res = await request(app.getHttpServer())
        .post(STUDIES)
        .send({ question: 'Why?' })
        .then((r) => r);
      expect([res.status, res.body]).toStrictEqual([
        401,
        envelope({ code: 'UNAUTHENTICATED', message: 'Sign in to continue' }),
      ]);
      expect(await Study.count()).toBe(before);
    });
  });

  describe('under real concurrency', () => {
    it('creates exactly one study for N concurrent identical requests with one key and replays it to the rest', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      const body = { startingReferenceId: romans.id, question: 'What is conscience?' };
      const responses = await raceOnKey(owner, key, RACERS, () => create(owner, body, key));

      expect(responses.map((r) => r.status)).toStrictEqual(Array(RACERS).fill(201));
      const fresh = responses.filter((r) => r.headers['idempotent-replayed'] === undefined);
      expect(fresh).toHaveLength(1);
      const original = fresh[0]?.body as CreateStudyResponse;
      for (const res of responses) expect(res.body).toStrictEqual(original);
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 2,
        branches: 1,
        events: 1,
        receipts: 1,
      });
    });

    it('creates one of N concurrent requests sharing a key but not a body; the rest get 422', async () => {
      const owner = await signedInUser();
      const key = randomUUID();
      let n = 0;
      const responses = await raceOnKey(owner, key, RACERS, () => {
        n += 1;
        return create(owner, { question: `Question ${n}` }, key);
      });
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toStrictEqual([201, ...Array<number>(RACERS - 1).fill(422)]);
      for (const res of responses.filter((r) => r.status === 422)) {
        expect(res.body).toStrictEqual(KEY_REUSED);
      }
      expect((await ownerRows(owner)).studies).toBe(1);
    });

    it('creates N independent studies for N concurrent requests with different keys, each starting at event 1', async () => {
      const owner = await signedInUser();
      const responses = await Promise.all(
        Array.from({ length: RACERS }, () =>
          create(owner, { startingReferenceId: romans.id }, randomUUID()),
        ),
      );
      expect(responses.map((r) => r.status)).toStrictEqual(Array(RACERS).fill(201));
      const ids = new Set(responses.map((r) => (r.body as CreateStudyResponse).studyId));
      expect(ids.size).toBe(RACERS);
      const sequences = await db.query<{ sequence: string }>(
        `SELECT sequence FROM study_event WHERE owner_id = $1`,
        { bind: [owner.user.id], type: QueryTypes.SELECT },
      );
      expect(sequences.map((r) => r.sequence)).toStrictEqual(Array(RACERS).fill('1'));
      expect(await ownerRows(owner)).toStrictEqual({
        studies: RACERS,
        nodes: RACERS,
        branches: RACERS,
        events: RACERS,
        receipts: RACERS,
      });
    });
  });

  describe('GET /v1/studies/:studyId', () => {
    it('returns what creation wrote, the same after a reload', async () => {
      const created = await create(alice, {
        startingReferenceId: romans.id,
        question: 'What is conscience?',
      });
      const body = created.body as CreateStudyResponse;

      const res = await read(alice, body.studyId);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toStrictEqual({
        id: body.studyId,
        title: 'Romans 9:1',
        lifecycle: 'active',
        revision: 1,
        contentRevision: 1,
        startingReference: romans,
        mainQuestion: { nodeId: body.questionNodeId, text: 'What is conscience?', status: 'open' },
        branchId: body.branchId,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      const reloaded = await read(alice, body.studyId);
      expect([reloaded.status, reloaded.body]).toStrictEqual([200, res.body]);
    });

    it('returns a blank study with no passage, question or branch', async () => {
      const created = await create(alice, { blank: true });
      const { studyId } = created.body as CreateStudyResponse;
      const res = await read(alice, studyId);
      expect([res.status, res.body]).toStrictEqual([
        200,
        {
          id: studyId,
          title: 'Untitled study',
          lifecycle: 'active',
          revision: 1,
          contentRevision: 1,
          startingReference: null,
          mainQuestion: null,
          branchId: null,
          createdAt: expect.any(String),
        },
      ]);
    });

    it('GET /v1/studies/:studyId gives another user the same neutral 404 as an absent or malformed id', async () => {
      const created = await create(alice, { question: 'What is conscience?' });
      const { studyId } = created.body as CreateStudyResponse;

      const foreign = await request(app.getHttpServer())
        .get(studyPath(studyId))
        .set('Cookie', bob.cookie);
      const absent = await read(bob, randomUUID());
      const malformed = await read(bob, 'not-a-study');
      expect([foreign.status, foreign.body]).toStrictEqual([404, NOT_FOUND]);
      expect([absent.status, absent.body]).toStrictEqual([404, NOT_FOUND]);
      expect([malformed.status, malformed.body]).toStrictEqual([404, NOT_FOUND]);
      // The owner still reads it.
      expect((await read(alice, studyId)).status).toBe(200);
    });
  });

  describe('hard delete (trash purge, account deletion)', () => {
    it('removes a study with its question, Scripture node, branch and events in one statement, leaving no orphans', async () => {
      const owner = await signedInUser();
      const keep = await create(owner, { question: 'Kept?' }, randomUUID());
      const created = await create(
        owner,
        { question: 'What is conscience?', startingReferenceId: romans.id },
        randomUUID(),
      );
      expect([keep.status, created.status]).toStrictEqual([201, 201]);
      const { studyId } = created.body as CreateStudyResponse;
      const keptId = (keep.body as CreateStudyResponse).studyId;
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 2,
        nodes: 3,
        branches: 2,
        events: 2,
        receipts: 2,
      });

      await db.query(`DELETE FROM study WHERE owner_id = $1 AND id = $2`, {
        bind: [owner.user.id, studyId],
      });

      const where = { studyId };
      expect([
        await Study.count({ where: { id: studyId } }),
        await StudyNode.count({ where }),
        await StudyBranch.count({ where }),
        await StudyEvent.count({ where }),
      ]).toStrictEqual([0, 0, 0, 0]);
      // The other study is untouched. Receipts are owner-scoped (not study-scoped): they stay
      // until they expire or the account is deleted, and the study they name now reads as 404.
      expect(await ownerRows(owner)).toStrictEqual({
        studies: 1,
        nodes: 1,
        branches: 1,
        events: 1,
        receipts: 2,
      });
      expect((await read(owner, keptId)).status).toBe(200);
      expect([(await read(owner, studyId)).status]).toStrictEqual([404]);
    });

    it('removes a user with their sessions, receipts, studies and every study row in one statement', async () => {
      const owner = await signedInUser();
      const other = await signedInUser();
      await create(owner, { question: 'Why?', startingReferenceId: jude.id }, randomUUID());
      await create(owner, { blank: true }, randomUUID());
      await create(other, { question: 'Why?' }, randomUUID());
      const otherBefore = await ownerRows(other);

      await db.query(`DELETE FROM "user" WHERE id = $1`, { bind: [owner.user.id] });

      expect(await ownerRows(owner)).toStrictEqual({
        studies: 0,
        nodes: 0,
        branches: 0,
        events: 0,
        receipts: 0,
      });
      expect(await AuthSession.count({ where: { userId: owner.user.id } })).toBe(0);
      expect(await ownerRows(other)).toStrictEqual(otherBefore);
    });
  });
});
