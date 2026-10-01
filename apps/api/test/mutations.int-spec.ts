import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryTypes, type Transaction } from 'sequelize';
import { NotFoundError, RevisionConflictError } from '../src/common/errors/domain-errors';
import { requestFingerprint } from '../src/common/mutation/fingerprint';
import { updateWithExpectedRevision } from '../src/common/revision/expected-revision';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { StudyRevisionService } from '../src/modules/study/study-revision.service';
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
  let studyRevisions: StudyRevisionService;
  let alice: Owner;
  let bob: Owner;
  const userIds: string[] = [];

  const mutationPath = (studyId: string): string => `/v1/__test/studies/${studyId}/mutations`;

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

  /** Backends of this database blocked on a lock taken by the mutation pipeline. */
  async function pipelineLockWaiters(): Promise<number> {
    const [row] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query LIKE '%mutation_receipt%' OR query LIKE 'UPDATE "study"%')`,
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
    await app.listen(0);
    db = app.get<Database>(DATABASE);
    thread = app.get(ThreadService);
    studyRevisions = app.get(StudyRevisionService);
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
        route: `POST ${mutationPath(study.id)}`,
        requestHash: requestFingerprint({ method: 'POST', path: mutationPath(study.id), body }),
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
        `POST ${mutationPath(study.id)}`,
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

    it('allocates gap-free, duplicate-free event sequences to concurrent transactions, some rolled back', async () => {
      const study = await newStudy(alice);
      let started = 0;
      const outcomes = await race(study.id, RACERS, () => {
        const index = started++;
        return db
          .transaction(async (transaction) => {
            const event = await thread.appendEvent(transaction, {
              ownerId: alice.user.id,
              studyId: study.id,
              eventType: 'note_created',
            });
            if (index % 2 === 1) throw new Error(`rollback ${event.sequence}`);
            return 'committed';
          })
          .catch(() => 'rolled back');
      });
      const committed = outcomes.filter((o) => o === 'committed').length;
      expect(committed).toBe(RACERS / 2);
      const after = await persisted(study);
      const expectedSequences = Array.from({ length: committed }, (_, i) => String(i + 1));
      expect(after.events.map((e) => e.sequence)).toStrictEqual(expectedSequences);
      expect(after.lastEventSequence).toBe(String(committed));
    });
  });

  describe('shared services', () => {
    it('refuses to append an event outside a transaction', async () => {
      const study = await newStudy(alice);
      await expect(
        thread.appendEvent(undefined as unknown as Transaction, {
          ownerId: alice.user.id,
          studyId: study.id,
          eventType: 'note_created',
        }),
      ).rejects.toThrow('requires the mutation transaction');
      expect((await persisted(study)).events).toStrictEqual([]);
    });

    it("refuses to allocate a sequence on another owner's study (404) and changes nothing", async () => {
      const study = await newStudy(alice);
      await expect(
        db.transaction((transaction) =>
          studyRevisions.nextEventSequence(transaction, bob.user.id, study.id),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await persisted(study)).lastEventSequence).toBe('0');
    });

    it('checks and bumps a node revision, and reports 409/404 for stale, foreign, or deleted nodes', async () => {
      const study = await newStudy(alice);
      const node = await StudyNode.create({
        studyId: study.id,
        ownerId: alice.user.id,
        type: 'question',
      });
      const deleted = await StudyNode.create({
        studyId: study.id,
        ownerId: alice.user.id,
        type: 'question',
        deletedAt: new Date(),
      });
      const live = (id: string, ownerId: string) => ({
        id,
        studyId: study.id,
        ownerId,
        deletedAt: null,
      });

      const updated = await db.transaction((transaction) =>
        updateWithExpectedRevision(StudyNode, {
          where: live(node.id, alice.user.id),
          expectedRevision: 1,
          values: {},
          transaction,
        }),
      );
      expect(updated.revision).toBe(2);

      const attempt = (id: string, ownerId: string, expectedRevision: number) =>
        db.transaction((transaction) =>
          updateWithExpectedRevision(StudyNode, {
            where: live(id, ownerId),
            expectedRevision,
            values: {},
            transaction,
          }),
        );
      await expect(attempt(node.id, alice.user.id, 1)).rejects.toStrictEqual(
        new RevisionConflictError(2),
      );
      await expect(attempt(node.id, bob.user.id, 2)).rejects.toBeInstanceOf(NotFoundError);
      await expect(attempt(deleted.id, alice.user.id, 1)).rejects.toBeInstanceOf(NotFoundError);
      expect((await StudyNode.findByPk(node.id, { rejectOnEmpty: true })).revision).toBe(2);
    });
  });
});
