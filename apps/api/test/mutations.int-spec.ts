import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { NotFoundError, RevisionConflictError } from '../src/common/errors/domain-errors';
import { requestFingerprint } from '../src/common/mutation/fingerprint';
import type { MutationRequestInfo } from '../src/common/mutation/mutation-request';
import {
  type MutationResponse,
  MutationService,
  type StudyMutationSpec,
} from '../src/common/mutation/mutation.service';
import type { StudyMutation } from '../src/common/mutation/study-mutation';
import { ENV } from '../src/config/config.module';
import { httpAllowedOrigins, type Env } from '../src/config/env';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { StudyLock } from '../src/modules/study/study-revision.service';
import { ThreadService } from '../src/modules/thread/thread.service';
import { createTestApp } from './app';
import { NOT_FOUND } from './support/envelopes';
import { MutationProbeModule } from './support/mutation-probe';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correlationId: unknown = expect.stringMatching(UUID);

const REVISION_MISSING = {
  code: 'REVISION_MISSING',
  message: 'expectedRevision is required',
  retryable: false,
  correlationId,
};
const revisionConflict = (currentRevision: number) => ({
  code: 'REVISION_CONFLICT',
  message: 'Revision conflict',
  retryable: false,
  correlationId,
  currentRevision,
});
const KEY_REUSED = {
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
  retryable: false,
  correlationId,
};
const INTERNAL_ERROR = {
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred',
  retryable: false,
  correlationId,
};

/** A service-level request with no Idempotency-Key (fingerprint fields are irrelevant then). */
const NO_KEY: MutationRequestInfo = {
  idempotencyKey: null,
  method: 'POST',
  route: '/service-level',
  params: {},
  body: {},
};

/** Concurrent requests per race. Each holds a pooled connection (pool max 10, see database.ts). */
const RACERS = 6;

/**
 * BIB-12: the shared mutation pipeline (Idempotency-Key receipts, expectedRevision, per-study
 * event sequence, mutation + event + receipt in one transaction), driven through the test-only
 * probe route `POST /v1/__test/studies/:studyId/mutations` and the exported services, against
 * real PostgreSQL.
 */
describe('revision-safe, event-atomic mutations', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let thread: ThreadService;
  let mutations: MutationService;
  let alice: Owner;
  let bob: Owner;
  const userIds: string[] = [];

  const RENAME_ROUTE = '/v1/__test/studies/:studyId/mutations';
  const mutationPath = (studyId: string): string => `/v1/__test/studies/${studyId}/mutations`;
  const nodeMutationPath = (studyId: string, nodeId: string): string =>
    `/v1/__test/studies/${studyId}/nodes/${nodeId}/mutations`;

  /** Sends the probe mutation and starts it immediately (supertest is otherwise lazy). */
  function mutate(
    owner: Owner,
    studyId: string,
    body: Record<string, unknown>,
    key?: string,
  ): Promise<Response> {
    let req = request(app.getHttpServer()).post(mutationPath(studyId)).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body).then((res) => res);
  }

  /** Sends the child-node probe mutation and starts it immediately. */
  function mutateNode(
    owner: Owner,
    studyId: string,
    nodeId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return request(app.getHttpServer())
      .post(nodeMutationPath(studyId, nodeId))
      .set('Cookie', owner.cookie)
      .send(body)
      .then((res) => res);
  }

  /** `MutationService.execute` for a study of `owner`, without HTTP or an Idempotency-Key. */
  function execute(
    owner: Owner,
    studyId: string,
    work: (m: StudyMutation) => Promise<MutationResponse>,
    spec: Partial<StudyMutationSpec> = {},
  ) {
    return mutations.execute(owner.user.id, NO_KEY, {
      studyId,
      bumpsContentRevision: true,
      work,
      ...spec,
    });
  }

  /** A revision check + event, the minimum a valid `work` must do; returns a 200 response. */
  async function minimalWork(m: StudyMutation, expectedRevision = 1): Promise<MutationResponse> {
    await m.updateWithExpectedRevision(Study, { id: m.studyId, expectedRevision, values: {} });
    await m.appendEvent({ eventType: 'study_renamed' });
    return { status: 200, body: {} };
  }

  async function newNode(owner: Owner, study: Study, deletedAt: Date | null = null) {
    return StudyNode.create({
      studyId: study.id,
      ownerId: owner.user.id,
      type: 'thought',
      deletedAt,
    });
  }

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const sessions = app.get(SessionService);
    const { token } = await db.transaction((transaction) => sessions.create(user.id, transaction));
    return { user, cookie: `ba_session=${token}` };
  }

  async function newStudy(owner: Owner): Promise<Study> {
    return Study.create({ ownerId: owner.user.id, title: 'Conscience' });
  }

  /** Everything a mutation may have written for this study and owner. */
  async function persisted(study: Study) {
    const row = await Study.findByPk(study.id, { rejectOnEmpty: true });
    const events = await StudyEvent.findAll({
      where: { studyId: study.id },
      order: [['sequence', 'ASC']],
    });
    const receipts = await MutationReceipt.count({ where: { ownerId: study.ownerId } });
    return {
      title: row.title,
      revision: row.revision,
      contentRevision: row.contentRevision,
      lastEventSequence: row.lastEventSequence,
      events: events.map((e) => ({ sequence: e.sequence, eventType: e.eventType })),
      receipts,
    };
  }

  /**
   * Backends of this database blocked on a row/tuple lock. Integration files run serially, so
   * every such waiter is one of this file's racers, whichever statement it happens to block on.
   */
  async function pipelineLockWaiters(): Promise<number> {
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
   * Makes `count` operations genuinely overlap: holds the study row lock in a gate transaction,
   * starts them, waits until all `count` are blocked inside PostgreSQL on the study row or on the
   * receipt's unique index, then releases the gate and collects their results.
   */
  async function race<T>(studyId: string, count: number, start: () => Promise<T>): Promise<T[]> {
    const gate = await db.transaction();
    try {
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [studyId],
        transaction: gate,
      });
    } catch (error) {
      await gate.rollback();
      throw error;
    }
    const pending = Array.from({ length: count }, start);
    try {
      const deadline = Date.now() + 10_000;
      while ((await pipelineLockWaiters()) < count) {
        if (Date.now() > deadline) throw new Error('racers never all blocked on the gate');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await gate.commit();
    }
    return Promise.all(pending);
  }

  beforeAll(async () => {
    app = await createTestApp(MutationProbeModule);
    db = app.get<Database>(DATABASE);
    thread = app.get(ThreadService);
    mutations = app.get(MutationService);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterAll(async () => {
    await StudyEvent.destroy({ where: { ownerId: userIds } });
    await StudyNode.destroy({ where: { ownerId: userIds } });
    await MutationReceipt.destroy({ where: { ownerId: userIds } });
    await Study.destroy({ where: { ownerId: userIds } });
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('a single request', () => {
    it('applies the change, bumps both revisions, and appends event 1, all after commit', async () => {
      const study = await newStudy(alice);
      const { receipts } = await persisted(study);
      const res = await mutate(alice, study.id, { expectedRevision: 1, title: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.body).toStrictEqual({
        studyId: study.id,
        revision: 2,
        contentRevision: 2,
        eventSequence: '1',
      });
      expect(await persisted(study)).toStrictEqual({
        title: 'Renamed',
        revision: 2,
        contentRevision: 2,
        lastEventSequence: '1',
        events: [{ sequence: '1', eventType: 'study_renamed' }],
        // No Idempotency-Key, so no receipt.
        receipts,
      });
    });

    it('allocates consecutive event sequences across successive mutations', async () => {
      const study = await newStudy(alice);
      for (const expectedRevision of [1, 2, 3]) {
        const res = await mutate(alice, study.id, {
          expectedRevision,
          title: `T${expectedRevision}`,
        });
        expect(res.body).toStrictEqual({
          studyId: study.id,
          revision: expectedRevision + 1,
          contentRevision: expectedRevision + 1,
          eventSequence: String(expectedRevision),
        });
      }
      expect((await persisted(study)).events.map((e) => e.sequence)).toStrictEqual(['1', '2', '3']);
    });

    it('returns 428 when expectedRevision is missing, and writes nothing', async () => {
      const study = await newStudy(alice);
      const before = await persisted(study);
      const res = await mutate(alice, study.id, { title: 'Renamed' }, randomUUID());
      expect(res.status).toBe(428);
      expect(res.body).toStrictEqual(REVISION_MISSING);
      expect(await persisted(study)).toStrictEqual(before);
    });

    it('returns 400 for a malformed expectedRevision', async () => {
      const study = await newStudy(alice);
      const res = await mutate(alice, study.id, { expectedRevision: '1', title: 'Renamed' });
      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { expectedRevision: [expect.any(String)] },
        retryable: false,
        correlationId,
      });
    });

    it('returns 400 for an Idempotency-Key that is not a UUID, without echoing it', async () => {
      const study = await newStudy(alice);
      const res = await mutate(
        alice,
        study.id,
        { expectedRevision: 1, title: 'Renamed' },
        'Romans 9:1',
      );
      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { 'Idempotency-Key': ['Must be a UUID'] },
        retryable: false,
        correlationId,
      });
      expect(JSON.stringify(res.body)).not.toContain('Romans');
      expect((await persisted(study)).revision).toBe(1);
    });

    it('returns 409 with currentRevision for a stale expectedRevision, and writes nothing', async () => {
      const study = await newStudy(alice);
      await mutate(alice, study.id, { expectedRevision: 1, title: 'First' });
      const before = await persisted(study);
      const key = randomUUID();
      const res = await mutate(alice, study.id, { expectedRevision: 1, title: 'Stale' }, key);
      expect(res.status).toBe(409);
      expect(res.body).toStrictEqual(revisionConflict(2));
      expect(await persisted(study)).toStrictEqual(before);
      expect(
        await MutationReceipt.findOne({ where: { ownerId: alice.user.id, idempotencyKey: key } }),
      ).toBeNull();
    });

    it('rolls back the change, event, and receipt when the work fails after writing, so a retry with the same key runs', async () => {
      const study = await newStudy(alice);
      const before = await persisted(study);
      const key = randomUUID();
      const failed = await mutate(
        alice,
        study.id,
        { expectedRevision: 1, title: 'Lost', failAfterWrite: true },
        key,
      );
      expect(failed.status).toBe(500);
      expect(failed.body).toStrictEqual(INTERNAL_ERROR);
      expect(await persisted(study)).toStrictEqual(before);

      const retried = await mutate(alice, study.id, { expectedRevision: 1, title: 'Kept' }, key);
      expect(retried.status).toBe(200);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
      expect(retried.body).toStrictEqual({
        studyId: study.id,
        revision: 2,
        contentRevision: 2,
        eventSequence: '1',
      });
    });
  });

  describe('Idempotency-Key', () => {
    it('replays the original status and body for the same key and body, without a second effect', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Renamed' };
      const first = await mutate(alice, study.id, body, key);
      const second = await mutate(alice, study.id, body, key.toUpperCase());
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toStrictEqual(first.body);
      const after = await persisted(study);
      expect({ revision: after.revision, events: after.events }).toStrictEqual({
        revision: 2,
        events: [{ sequence: '1', eventType: 'study_renamed' }],
      });

      const receipt = await MutationReceipt.findOne({
        where: { ownerId: alice.user.id, idempotencyKey: key },
        rejectOnEmpty: true,
      });
      expect(receipt.get({ plain: true })).toStrictEqual({
        ownerId: alice.user.id,
        idempotencyKey: key,
        // The route pattern, not the URL: no IDs, and every spelling of the URL fingerprints alike.
        route: `POST ${RENAME_ROUTE}`,
        requestHash: requestFingerprint({
          method: 'POST',
          route: RENAME_ROUTE,
          params: { studyId: study.id },
          body,
        }),
        responseStatus: 200,
        responseBody: first.body,
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      });
      expect(receipt.expiresAt.getTime() - receipt.createdAt.getTime()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    });

    it('treats a reordered but equal body as the same request', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const first = await mutate(alice, study.id, { expectedRevision: 1, title: 'A' }, key);
      const second = await mutate(alice, study.id, { title: 'A', expectedRevision: 1 }, key);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toStrictEqual(first.body);
    });

    it('replays the original response even after the study has moved on', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const first = await mutate(alice, study.id, { expectedRevision: 1, title: 'A' }, key);
      await mutate(alice, study.id, { expectedRevision: 2, title: 'B' }, randomUUID());
      const replay = await mutate(alice, study.id, { expectedRevision: 1, title: 'A' }, key);
      expect(replay.status).toBe(200);
      expect(replay.body).toStrictEqual(first.body);
      expect((await persisted(study)).title).toBe('B');
    });

    it('rejects the same key with a different body with 422, and writes nothing', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      await mutate(alice, study.id, { expectedRevision: 1, title: 'A' }, key);
      const before = await persisted(study);
      const res = await mutate(alice, study.id, { expectedRevision: 2, title: 'B' }, key);
      expect(res.status).toBe(422);
      expect(res.body).toStrictEqual(KEY_REUSED);
      expect(await persisted(study)).toStrictEqual(before);
    });

    it('rejects the same key on a different route (path) with 422', async () => {
      const first = await newStudy(alice);
      const other = await newStudy(alice);
      const key = randomUUID();
      await mutate(alice, first.id, { expectedRevision: 1, title: 'A' }, key);
      const res = await mutate(alice, other.id, { expectedRevision: 1, title: 'A' }, key);
      expect(res.status).toBe(422);
      expect(res.body).toStrictEqual(KEY_REUSED);
      expect((await persisted(other)).revision).toBe(1);
    });

    it('lets an expired receipt key be claimed afresh', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      await MutationReceipt.create({
        ownerId: alice.user.id,
        idempotencyKey: key,
        route: 'POST /elsewhere',
        requestHash: 'a'.repeat(64),
        responseStatus: 201,
        responseBody: { old: true },
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const res = await mutate(alice, study.id, { expectedRevision: 1, title: 'Fresh' }, key);
      expect(res.status).toBe(200);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      const receipt = await MutationReceipt.findOne({
        where: { ownerId: alice.user.id, idempotencyKey: key },
        rejectOnEmpty: true,
      });
      expect([receipt.route, receipt.responseStatus, receipt.responseBody]).toStrictEqual([
        `POST ${RENAME_ROUTE}`,
        200,
        res.body,
      ]);
      expect(receipt.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('keeps receipts per owner: the same key value from another user runs their own mutation', async () => {
      const aliceStudy = await newStudy(alice);
      const bobStudy = await newStudy(bob);
      const key = randomUUID();
      const aliceRes = await mutate(alice, aliceStudy.id, { expectedRevision: 1, title: 'A' }, key);
      const bobRes = await mutate(bob, bobStudy.id, { expectedRevision: 1, title: 'A' }, key);
      expect(bobRes.status).toBe(200);
      expect(bobRes.headers['idempotent-replayed']).toBeUndefined();
      expect(bobRes.body).toStrictEqual({
        studyId: bobStudy.id,
        revision: 2,
        contentRevision: 2,
        eventSequence: '1',
      });
      expect(aliceRes.body).toStrictEqual({
        studyId: aliceStudy.id,
        revision: 2,
        contentRevision: 2,
        eventSequence: '1',
      });
      expect(await MutationReceipt.count({ where: { idempotencyKey: key } })).toBe(2);
    });
  });

  describe('owner isolation', () => {
    it('gets the neutral 404 when another user mutates a study they do not own', async () => {
      const study = await newStudy(alice);
      const before = await persisted(study);
      const key = randomUUID();
      const res = await request(app.getHttpServer())
        .post(mutationPath(study.id))
        .set('Cookie', bob.cookie)
        .set('Idempotency-Key', key)
        .send({ expectedRevision: 1, title: 'Hijack' });
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
      expect(await persisted(study)).toStrictEqual(before);
      expect(await MutationReceipt.count({ where: { idempotencyKey: key } })).toBe(0);
    });

    it('gets the neutral 404 when another user mutates a node of a study they do not own', async () => {
      const study = await newStudy(alice);
      const node = await newNode(alice, study);
      const before = await persisted(study);
      const res = await request(app.getHttpServer())
        .post(nodeMutationPath(study.id, node.id))
        .set('Cookie', bob.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ expectedRevision: 1 });
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
      expect(await persisted(study)).toStrictEqual(before);
      expect((await StudyNode.findByPk(node.id, { rejectOnEmpty: true })).revision).toBe(1);
    });

    it('gets the same 404 for a stale revision on a foreign study (no revision leak)', async () => {
      const study = await newStudy(alice);
      await mutate(alice, study.id, { expectedRevision: 1, title: 'A' });
      const res = await mutate(bob, study.id, { expectedRevision: 1, title: 'B' });
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    });
  });

  describe('under real concurrency', () => {
    it('lets exactly one of N writers with the same expectedRevision win; the rest get 409', async () => {
      const study = await newStudy(alice);
      const results = await race(study.id, RACERS, () =>
        mutate(alice, study.id, { expectedRevision: 1, title: `W${randomUUID()}` }, randomUUID()),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toStrictEqual([200, ...Array<number>(RACERS - 1).fill(409)]);
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(loser.body).toStrictEqual(revisionConflict(2));
      }
      const [winner] = results.filter((r) => r.status === 200);
      expect(winner?.body).toStrictEqual({
        studyId: study.id,
        revision: 2,
        contentRevision: 2,
        eventSequence: '1',
      });
      const { title, revision, contentRevision, lastEventSequence, events } =
        await persisted(study);
      expect({ revision, contentRevision, lastEventSequence, events }).toStrictEqual({
        revision: 2,
        contentRevision: 2,
        lastEventSequence: '1',
        events: [{ sequence: '1', eventType: 'study_renamed' }],
      });
      // The single committed title is the winner's: no loser's write leaked through.
      expect(title).toMatch(/^W/);
    });

    it('executes N concurrent identical requests with one key exactly once and replays it to the rest', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const results = await race(study.id, RACERS, () =>
        mutate(alice, study.id, { expectedRevision: 1, title: 'Once' }, key),
      );
      const expected = { studyId: study.id, revision: 2, contentRevision: 2, eventSequence: '1' };
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body).toStrictEqual(expected);
      }
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(
        RACERS - 1,
      );
      const after = await persisted(study);
      expect({ revision: after.revision, events: after.events }).toStrictEqual({
        revision: 2,
        events: [{ sequence: '1', eventType: 'study_renamed' }],
      });
      expect(
        await MutationReceipt.count({ where: { ownerId: alice.user.id, idempotencyKey: key } }),
      ).toBe(1);
    });

    it('runs one of N concurrent requests sharing a key but not a body; the rest get 422', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      let n = 0;
      const results = await race(study.id, RACERS, () => {
        n += 1;
        return mutate(alice, study.id, { expectedRevision: 1, title: `Body ${n}` }, key);
      });
      expect(results.map((r) => r.status).sort()).toStrictEqual([
        200,
        ...Array<number>(RACERS - 1).fill(422),
      ]);
      for (const loser of results.filter((r) => r.status === 422)) {
        expect(loser.body).toStrictEqual(KEY_REUSED);
      }
      const after = await persisted(study);
      expect({ revision: after.revision, events: after.events }).toStrictEqual({
        revision: 2,
        events: [{ sequence: '1', eventType: 'study_renamed' }],
      });
    });

    it('allocates gap-free, duplicate-free event sequences to concurrent mutations, some rolled back', async () => {
      const study = await newStudy(alice);
      const nodes = await Promise.all(Array.from({ length: RACERS }, () => newNode(alice, study)));
      let started = 0;
      const outcomes = await race(study.id, RACERS, () => {
        const index = started++;
        const node = nodes[index];
        if (!node) throw new Error('missing node');
        return execute(alice, study.id, async (m) => {
          await m.updateWithExpectedRevision(StudyNode, {
            id: node.id,
            expectedRevision: 1,
            values: {},
          });
          const event = await m.appendEvent({ eventType: 'node_updated' });
          if (index % 2 === 1) throw new Error(`rollback ${event.sequence}`);
          return { status: 200, body: {} };
        }).then(
          () => 'committed',
          () => 'rolled back',
        );
      });
      const committed = outcomes.filter((o) => o === 'committed').length;
      expect(committed).toBe(RACERS / 2);
      const after = await persisted(study);
      const expectedSequences = Array.from({ length: committed }, (_, i) => String(i + 1));
      expect(after.events.map((e) => e.sequence)).toStrictEqual(expectedSequences);
      expect(after.lastEventSequence).toBe(String(committed));
      expect(after.contentRevision).toBe(1 + committed);
    });

    it('runs a child mutation and a study-level mutation of the same child concurrently without deadlock', async () => {
      // Each holds its first row lock for 300 ms before taking the second. With the old order
      // (child mutation: node → study; study mutation: study → node) this deadlocks every round
      // and PostgreSQL aborts one as 40P01 (503 TRANSIENT_CONFLICT). With the study row always
      // locked first, the second mutation just queues behind the first and both succeed.
      for (let round = 0; round < 3; round += 1) {
        const study = await newStudy(alice);
        const node = await newNode(alice, study);
        let n = 0;
        const results = await race(study.id, 2, () =>
          n++ === 0
            ? mutateNode(alice, study.id, node.id, { expectedRevision: 1, pauseMs: 300 })
            : mutate(alice, study.id, {
                expectedRevision: 1,
                title: 'Study-level',
                touchNodes: true,
                pauseMs: 300,
              }),
        );
        expect(results.map((r) => [r.status, (r.body as { code?: unknown }).code])).toStrictEqual([
          [200, undefined],
          [200, undefined],
        ]);
        const after = await persisted(study);
        expect(after.events.map((e) => e.sequence)).toStrictEqual(['1', '2']);
        expect([after.revision, after.contentRevision]).toStrictEqual([2, 3]);
      }
    });
  });

  describe('lock order and counters', () => {
    /** Runs `fn` and returns the SQL each completed statement ran, in order. */
    async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
      const seen: string[] = [];
      db.addHook('afterQuery', 'record', (_options, query) => {
        const { sql } = query as unknown as { sql?: unknown };
        if (typeof sql === 'string') seen.push(sql);
      });
      try {
        await fn();
      } finally {
        db.removeHook('afterQuery', 'record');
      }
      return seen;
    }

    const kind = (sql: string): string => {
      if (/^(START TRANSACTION|BEGIN)/.test(sql)) return 'begin';
      if (/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED/.test(sql)) return 'read committed';
      if (/^COMMIT/.test(sql)) return 'commit';
      if (/INSERT INTO mutation_receipt/.test(sql)) return 'claim receipt';
      if (/^UPDATE "mutation_receipt"/.test(sql)) return 'store receipt';
      if (/^SELECT .* FROM "study" .*FOR UPDATE/.test(sql)) return 'lock study';
      if (/^UPDATE "study" SET "content_revision"/.test(sql)) return 'write study counters';
      if (/^UPDATE "study"/.test(sql)) return 'update study';
      if (/^UPDATE "study_node"/.test(sql)) return 'update node';
      if (/^INSERT INTO "study_event"/.test(sql)) return 'insert event';
      return sql.slice(0, 40);
    };

    it('locks the study before any child row, and writes the counters in one UPDATE', async () => {
      const study = await newStudy(alice);
      const node = await newNode(alice, study);
      const sql = await statementsOf(() =>
        request(app.getHttpServer())
          .post(nodeMutationPath(study.id, node.id))
          .set('Cookie', alice.cookie)
          .set('Idempotency-Key', randomUUID())
          .send({ expectedRevision: 1 })
          .expect(200),
      );
      expect(sql.map(kind).filter((k) => !k.startsWith('SELECT "id"'))).toStrictEqual([
        'begin',
        'read committed',
        'claim receipt',
        'lock study',
        'update node',
        'insert event',
        'write study counters',
        'store receipt',
        'commit',
      ]);
      const after = await persisted(study);
      expect([after.contentRevision, after.lastEventSequence]).toStrictEqual([2, '1']);
    });

    it('counts several events of one mutation in the same single counter UPDATE', async () => {
      const study = await newStudy(alice);
      const sql = await statementsOf(() =>
        execute(alice, study.id, async (m) => {
          await m.updateWithExpectedRevision(Study, {
            id: study.id,
            expectedRevision: 1,
            values: {},
          });
          const sequences = [];
          for (const eventType of ['a', 'b', 'c']) {
            sequences.push((await m.appendEvent({ eventType })).sequence);
          }
          return { status: 200, body: { sequences } };
        }),
      );
      expect(sql.map(kind).filter((k) => k === 'write study counters')).toHaveLength(1);
      const after = await persisted(study);
      expect(after.events.map((e) => [e.sequence, e.eventType])).toStrictEqual([
        ['1', 'a'],
        ['2', 'b'],
        ['3', 'c'],
      ]);
      expect([after.contentRevision, after.lastEventSequence]).toStrictEqual([2, '3']);
    });

    it('leaves content_revision alone for a mutation declared as not a content change', async () => {
      const study = await newStudy(alice);
      const result = await execute(
        alice,
        study.id,
        async (m) => {
          await minimalWork(m);
          return { status: 200, body: { contentRevision: m.contentRevision } };
        },
        { bumpsContentRevision: false },
      );
      expect(result.body).toStrictEqual({ contentRevision: 1 });
      const after = await persisted(study);
      expect([after.revision, after.contentRevision, after.lastEventSequence]).toStrictEqual([
        2,
        1,
        '1',
      ]);
    });
  });

  describe('misuse resistance', () => {
    it('rolls back a write inside work that did not pass the transaction', async () => {
      const study = await newStudy(alice);
      await expect(
        execute(alice, study.id, async (m) => {
          await minimalWork(m);
          // No `{ transaction }`: it must still join the mutation transaction.
          await StudyNode.create({ studyId: study.id, ownerId: alice.user.id, type: 'thought' });
          await db.query(`UPDATE study SET title = 'Stray' WHERE id = $1`, { bind: [study.id] });
          throw new Error('work failed after a stray write');
        }),
      ).rejects.toThrow('work failed after a stray write');
      expect(await StudyNode.count({ where: { studyId: study.id } })).toBe(0);
      const after = await persisted(study);
      expect([after.title, after.revision, after.events]).toStrictEqual(['Conscience', 1, []]);
    });

    it('commits a write inside work that did not pass the transaction together with the mutation', async () => {
      const study = await newStudy(alice);
      await execute(alice, study.id, async (m) => {
        await StudyNode.create({ studyId: study.id, ownerId: alice.user.id, type: 'thought' });
        const [row] = await db.query<{ same: boolean }>(
          // Same transaction ⇒ it sees the uncommitted node and shares the backend's xid.
          `SELECT count(*) = 1 AS same FROM study_node WHERE study_id = $1`,
          { bind: [study.id], type: QueryTypes.SELECT },
        );
        expect(row?.same).toBe(true);
        return minimalWork(m);
      });
      expect(await StudyNode.count({ where: { studyId: study.id } })).toBe(1);
    });

    it('fails loudly, writing nothing, when work makes no revision check', async () => {
      const study = await newStudy(alice);
      await expect(
        execute(alice, study.id, async (m) => {
          await m.appendEvent({ eventType: 'study_renamed' });
          return { status: 200, body: {} };
        }),
      ).rejects.toThrow('work made no revision check');
      const after = await persisted(study);
      expect([after.contentRevision, after.lastEventSequence, after.events]).toStrictEqual([
        1,
        '0',
        [],
      ]);
    });

    it('fails loudly, writing nothing, when work appends no event', async () => {
      const study = await newStudy(alice);
      await expect(
        execute(alice, study.id, async (m) => {
          await m.updateWithExpectedRevision(Study, {
            id: study.id,
            expectedRevision: 1,
            values: { title: 'X' },
          });
          return { status: 200, body: {} };
        }),
      ).rejects.toThrow('work appended no StudyEvent');
      const after = await persisted(study);
      expect([after.title, after.revision, after.contentRevision]).toStrictEqual([
        'Conscience',
        1,
        1,
      ]);
    });

    it('refuses to use the mutation context after work has finished', async () => {
      const study = await newStudy(alice);
      let leaked: StudyMutation | undefined;
      await execute(alice, study.id, async (m) => {
        leaked = m;
        return minimalWork(m);
      });
      await expect(leaked!.appendEvent({ eventType: 'late' })).rejects.toThrow(
        'used after its work finished',
      );
      expect((await persisted(study)).events).toHaveLength(1);
    });

    it('refuses a nested execute inside a running transaction', async () => {
      const study = await newStudy(alice);
      await expect(
        db.transaction(() => execute(alice, study.id, (m) => minimalWork(m))),
      ).rejects.toThrow('cannot run inside another transaction');
      expect((await persisted(study)).revision).toBe(1);
    });

    it('refuses to revision-check another study, or a table that is not study-scoped', async () => {
      const study = await newStudy(alice);
      const other = await newStudy(alice);
      await expect(
        execute(alice, study.id, async (m) => {
          await m.updateWithExpectedRevision(Study, {
            id: other.id,
            expectedRevision: 1,
            values: {},
          });
          return { status: 200, body: {} };
        }),
      ).rejects.toThrow('may only revision-check its own study');
      await expect(
        execute(alice, study.id, async (m) => {
          await m.updateWithExpectedRevision(User as never, {
            id: alice.user.id,
            expectedRevision: 1,
            values: {},
          });
          return { status: 200, body: {} };
        }),
      ).rejects.toThrow('neither the study nor a study-scoped child');
      expect((await persisted(other)).revision).toBe(1);
    });

    it('refuses to append an event without the mutation StudyLock', async () => {
      await expect(
        thread.appendEvent(undefined as unknown as StudyLock, { eventType: 'note_created' }),
      ).rejects.toThrow('requires the mutation StudyLock');
    });
  });

  describe('shared services', () => {
    it("refuses to mutate another owner's study (404) and changes nothing", async () => {
      const study = await newStudy(alice);
      await expect(execute(bob, study.id, (m) => minimalWork(m))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const after = await persisted(study);
      expect([after.revision, after.lastEventSequence]).toStrictEqual([1, '0']);
    });

    it('checks and bumps a node revision, and reports 409/404 for stale, foreign-study, or deleted nodes', async () => {
      const study = await newStudy(alice);
      const node = await newNode(alice, study);
      const deleted = await newNode(alice, study, new Date());
      const bobStudy = await newStudy(bob);
      const bobNode = await newNode(bob, bobStudy);

      const attempt = (id: string, expectedRevision: number) =>
        execute(alice, study.id, async (m) => {
          const updated = await m.updateWithExpectedRevision(StudyNode, {
            id,
            expectedRevision,
            values: {},
            where: { deletedAt: null },
          });
          await m.appendEvent({ eventType: 'node_updated' });
          return { status: 200, body: { revision: updated.revision } };
        });

      expect((await attempt(node.id, 1)).body).toStrictEqual({ revision: 2 });
      await expect(attempt(node.id, 1)).rejects.toStrictEqual(new RevisionConflictError(2));
      await expect(attempt(bobNode.id, 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(attempt(deleted.id, 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(attempt('not-a-uuid', 1)).rejects.toBeInstanceOf(NotFoundError);
      expect((await StudyNode.findByPk(node.id, { rejectOnEmpty: true })).revision).toBe(2);
      expect((await StudyNode.findByPk(bobNode.id, { rejectOnEmpty: true })).revision).toBe(1);
    });
  });

  describe('HTTP response from the returned MutationResult', () => {
    it('replays a 201 as 201 with Idempotent-Replayed and no-store', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Created', status: 201 };
      const first = await mutate(alice, study.id, body, key);
      const replay = await mutate(alice, study.id, body, key);
      expect([first.status, first.headers['idempotent-replayed']]).toStrictEqual([201, undefined]);
      expect([replay.status, replay.headers['idempotent-replayed']]).toStrictEqual([201, 'true']);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(replay.headers['cache-control']).toBe('no-store');
      expect(replay.body).toStrictEqual(first.body);
    });

    it('sends 200 (not POST’s default 201) for a 200 mutation, first time and on replay', async () => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Updated' };
      const first = await mutate(alice, study.id, body, key);
      const replay = await mutate(alice, study.id, body, key);
      expect([first.status, replay.status]).toStrictEqual([200, 200]);
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });

    it('lets a browser on an allowed origin read Idempotent-Replayed (CORS exposed header)', async () => {
      const [origin] = httpAllowedOrigins(app.get<Env>(ENV));
      if (!origin) throw new Error('test env has no CORS origin');
      const study = await newStudy(alice);
      const key = randomUUID();
      const send = () =>
        request(app.getHttpServer())
          .post(mutationPath(study.id))
          .set('Origin', origin)
          .set('Cookie', alice.cookie)
          .set('Idempotency-Key', key)
          .send({ expectedRevision: 1, title: 'Cross-origin' });
      await send().expect(200);
      const replay = await send().expect(200);
      expect(replay.headers['access-control-allow-origin']).toBe(origin);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const exposed = String(replay.headers['access-control-expose-headers'])
        .split(',')
        .map((h) => h.trim().toLowerCase());
      expect(exposed).toEqual(expect.arrayContaining(['idempotent-replayed', 'retry-after']));
    });

    it('throws rather than serializing a MutationResult that bypassed the interceptor', async () => {
      const study = await newStudy(alice);
      const result = await execute(alice, study.id, (m) => minimalWork(m));
      expect(() => JSON.stringify(result)).toThrow('must be returned from a controller');
    });
  });

  describe('request fingerprint spelling variants', () => {
    it.each([
      ['an upper-case study ID', (id: string) => mutationPath(id.toUpperCase())],
      ['a trailing slash', (id: string) => `${mutationPath(id)}/`],
      [
        'a percent-encoded study ID',
        (id: string) =>
          mutationPath(id.replace(/[a-f]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)),
      ],
      ['a query string', (id: string) => `${mutationPath(id)}?utm=1`],
    ])('replays the same key sent with %s instead of 422', async (_, spell) => {
      const study = await newStudy(alice);
      const key = randomUUID();
      const body = { expectedRevision: 1, title: 'Once' };
      const first = await mutate(alice, study.id, body, key);
      const variant = await request(app.getHttpServer())
        .post(spell(study.id))
        .set('Cookie', alice.cookie)
        .set('Idempotency-Key', key)
        .send(body);
      expect([first.status, variant.status]).toStrictEqual([200, 200]);
      expect(variant.headers['idempotent-replayed']).toBe('true');
      expect(variant.body).toStrictEqual(first.body);
      expect((await persisted(study)).events).toHaveLength(1);
    });
  });

  describe('creation entry point (BIB-19)', () => {
    /** A creation through `MutationService.create` for alice, without HTTP or a key. */
    function create(title: string, work: (m: StudyMutation) => Promise<MutationResponse>) {
      return mutations.create(alice.user.id, NO_KEY, {
        study: { title, startingReferenceId: null },
        work,
      });
    }

    it('creates the study at revision 1 and content revision 1 with event 1, needing no revision check', async () => {
      const title = `New ${randomUUID()}`;
      const result = await create(title, async (m) => {
        const node = await m.createChild(StudyNode, { type: 'thought' });
        const event = await m.appendEvent({ eventType: 'study_created' });
        return {
          status: 201,
          body: { creating: m.creating, studyId: m.studyId, nodeId: node.id, event },
        };
      });
      const body = result.body as { studyId: string; nodeId: string };
      expect([result.status, result.replayed, result.body]).toStrictEqual([
        201,
        false,
        {
          creating: true,
          studyId: expect.stringMatching(UUID),
          nodeId: expect.stringMatching(UUID),
          event: { id: expect.stringMatching(UUID), sequence: '1' },
        },
      ]);
      const study = await Study.findByPk(body.studyId, { rejectOnEmpty: true });
      expect(await persisted(study)).toMatchObject({
        title,
        revision: 1,
        contentRevision: 1,
        lastEventSequence: '1',
        events: [{ sequence: '1', eventType: 'study_created' }],
      });
      // The child carries the new study and the session owner, never anything from the caller.
      const node = await StudyNode.findByPk(body.nodeId, { rejectOnEmpty: true });
      expect([node.studyId, node.ownerId]).toStrictEqual([study.id, alice.user.id]);
    });

    it('writes no study when the work appends no event, or fails after writing children', async () => {
      const title = `Rolled back ${randomUUID()}`;
      await expect(
        create(title, async (m) => {
          await m.createChild(StudyNode, { type: 'thought' });
          return { status: 201, body: {} };
        }),
      ).rejects.toThrow('work appended no StudyEvent');
      await expect(
        create(title, async (m) => {
          await m.createChild(StudyNode, { type: 'thought' });
          await m.appendEvent({ eventType: 'study_created' });
          throw new Error('work failed after writing');
        }),
      ).rejects.toThrow('work failed after writing');
      expect(await Study.count({ where: { title } })).toBe(0);
    });

    it('refuses a nested create, root pointers on an existing study, and children of tables that are not study-scoped', async () => {
      await expect(
        db.transaction(() =>
          create('Nested', async (m) => {
            await m.appendEvent({ eventType: 'study_created' });
            return { status: 201, body: {} };
          }),
        ),
      ).rejects.toThrow('cannot run inside another transaction');

      const study = await newStudy(alice);
      await expect(
        execute(alice, study.id, async (m) => {
          await minimalWork(m);
          await m.updateCreatedStudy({ mainQuestionNodeId: null });
          return { status: 200, body: {} };
        }),
      ).rejects.toThrow('only for the study being created');
      expect((await persisted(study)).revision).toBe(1);

      await expect(
        create(`Bad child ${randomUUID()}`, async (m) => {
          // A table without study_id/owner_id: refused before any insert.
          await m.createChild(User, {});
          return { status: 201, body: {} };
        }),
      ).rejects.toThrow('not a study-scoped child');
    });

    it('replays a keyed creation and never creates a second study', async () => {
      const key = randomUUID();
      const request: MutationRequestInfo = {
        idempotencyKey: key,
        method: 'POST',
        route: '/service-level/studies',
        params: {},
        body: { title: 'Keyed' },
      };
      const work = async (m: StudyMutation): Promise<MutationResponse> => {
        await m.appendEvent({ eventType: 'study_created' });
        return { status: 201, body: { studyId: m.studyId } };
      };
      const spec = { study: { title: `Keyed ${key}`, startingReferenceId: null }, work };
      const first = await mutations.create(alice.user.id, request, spec);
      const second = await mutations.create(alice.user.id, request, spec);
      expect([second.status, second.replayed, second.body]).toStrictEqual([201, true, first.body]);
      expect(await Study.count({ where: { title: `Keyed ${key}` } })).toBe(1);
    });
  });
});
