import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type INestApplication, Logger, Module } from '@nestjs/common';
import type {
  CreateStudyResponse,
  StudyLifecycleResponse,
  StudyListResponse,
  StudyResponse,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { NotFoundError } from '../src/common/errors/domain-errors';
import { SessionService } from '../src/modules/identity/session.service';
import { StudyAccessService } from '../src/modules/study/study-access.service';
import { StudyTrashPurgeService } from '../src/modules/study/trash/study-trash-purge.service';
import { StudyTrashModule } from '../src/modules/study/trash/study-trash.module';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';
import { MutationProbeModule } from './support/mutation-probe';

interface Owner {
  user: User;
  cookie: string;
}

type Transition = 'archive' | 'unarchive' | 'trash' | 'restore';

const DAY_MS = 24 * 60 * 60 * 1000;
const STUDIES = '/v1/studies';
const studyPath = (studyId: string): string => `/v1/studies/${studyId}`;
const archivePath = (studyId: string): string => `/v1/studies/${studyId}/archive`;
const unarchivePath = (studyId: string): string => `/v1/studies/${studyId}/unarchive`;
const restorePath = (studyId: string): string => `/v1/studies/${studyId}/restore`;
const probePath = (studyId: string): string => `/v1/__test/studies/${studyId}/mutations`;
const probeNodePath = (studyId: string, nodeId: string): string =>
  `/v1/__test/studies/${studyId}/nodes/${nodeId}/mutations`;

const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
});
const STUDY_TRASHED = envelope({
  code: 'STUDY_TRASHED',
  message: 'This study is in the trash. Restore it to make changes',
});
const TRANSITION_INVALID = envelope({
  code: 'LIFECYCLE_TRANSITION_INVALID',
  message: 'This study is not in a state that allows this change',
});
const REVISION_MISSING = envelope({
  code: 'REVISION_MISSING',
  message: 'expectedRevision is required',
});
const conflict = (currentRevision: number) =>
  envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision });
const KEY_REUSED = envelope({
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});

/** The app with the BIB-12 probe mutations, plus the worker's trash purge. */
@Module({ imports: [MutationProbeModule, StudyTrashModule] })
class LifecycleTestModule {}

/**
 * BIB-22: archive, unarchive, trash and restore (`POST /v1/studies/:id/archive|unarchive|restore`,
 * `DELETE /v1/studies/:id`), the pipeline's lifecycle guard that every other study mutation
 * passes, the 30-day recovery window, and the purge. Real PostgreSQL throughout. The test app
 * also mounts the BIB-12 probe mutations, which stand in for every later study mutation route: the
 * guard lives in `MutationService.execute`, so they are refused exactly like `PATCH`.
 */
describe('study lifecycle (BIB-22)', () => {
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

  async function createStudy(owner: Owner, body: object = { question: 'What is conscience?' }) {
    const res = await request(app.getHttpServer())
      .post(STUDIES)
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(201);
    return res.body as CreateStudyResponse;
  }

  const pathOf: Record<Transition, (studyId: string) => string> = {
    archive: archivePath,
    unarchive: unarchivePath,
    trash: studyPath,
    restore: restorePath,
  };

  /** Sends one lifecycle request and starts it immediately (supertest is otherwise lazy). */
  function change(
    owner: Owner,
    transition: Transition,
    studyId: string,
    body: unknown,
    key?: string,
  ): Promise<Response> {
    const server = app.getHttpServer();
    const path = pathOf[transition](studyId);
    let req = transition === 'trash' ? request(server).delete(path) : request(server).post(path);
    req = req.set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body as object).then((res) => res);
  }

  /** A lifecycle change that must succeed; returns its 200 body. */
  async function changed(
    owner: Owner,
    transition: Transition,
    studyId: string,
    expectedRevision: number,
  ): Promise<StudyLifecycleResponse> {
    const res = await change(owner, transition, studyId, { expectedRevision });
    expect([res.status, res.body]).toStrictEqual([200, expect.any(Object)]);
    return res.body as StudyLifecycleResponse;
  }

  function read(owner: Owner, studyId: string): Promise<Response> {
    return request(app.getHttpServer())
      .get(studyPath(studyId))
      .set('Cookie', owner.cookie)
      .then((res) => res);
  }

  function patch(owner: Owner, studyId: string, body: object, key?: string): Promise<Response> {
    let req = request(app.getHttpServer()).patch(studyPath(studyId)).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body).then((res) => res);
  }

  function probe(owner: Owner, studyId: string, body: object): Promise<Response> {
    return request(app.getHttpServer())
      .post(probePath(studyId))
      .set('Cookie', owner.cookie)
      .send(body)
      .then((res) => res);
  }

  function probeNode(owner: Owner, studyId: string, nodeId: string): Promise<Response> {
    return request(app.getHttpServer())
      .post(probeNodePath(studyId, nodeId))
      .set('Cookie', owner.cookie)
      .send({ expectedRevision: 1 })
      .then((res) => res);
  }

  async function library(owner: Owner, state: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .get(STUDIES)
      .query({ state, pinnedFirst: 'false' })
      .set('Cookie', owner.cookie)
      .expect(200);
    return (res.body as StudyListResponse).items.map((item) => item.id);
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: e.payloadJson,
    }));
  }

  /** Every row a mutation of this owner may write, to prove a refusal wrote nothing. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: [
          'id',
          'title',
          'lifecycle',
          'archivedAt',
          'deletedAt',
          'revision',
          'contentRevision',
          'lastEventSequence',
          'lastActivityAt',
        ],
        order: [['id', 'ASC']],
        raw: true,
      }),
      nodes: await StudyNode.findAll({ where, attributes: ['id', 'revision'], raw: true }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  /** Moves a trashed study's `deleted_at` back by `days` (the lifecycle is untouched). */
  async function trashedDaysAgo(studyId: string, days: number, extraMs = 0): Promise<void> {
    await db.query(`UPDATE study SET deleted_at = $2 WHERE id = $1 AND lifecycle = 'trashed'`, {
      bind: [studyId, new Date(Date.now() - days * DAY_MS - extraMs)],
      type: QueryTypes.UPDATE,
    });
  }

  beforeAll(async () => {
    app = await createTestApp(LifecycleTestModule);
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterAll(async () => {
    // Deleting a user cascades to sessions, receipts, tags and studies, and each study to its
    // nodes, branches, events and tag pairs.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('archive and unarchive', () => {
    it('archives an active study: read-only, readable, out of the active library, one study_archived event; unarchive makes it editable again', async () => {
      const { studyId, questionNodeId, branchId } = await createStudy(alice);
      const before = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const question = { nodeId: questionNodeId, text: 'What is conscience?', status: 'open' };

      const res = await change(alice, 'archive', studyId, { expectedRevision: 1 });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toStrictEqual({
        id: studyId,
        title: 'What is conscience?',
        description: null,
        lifecycle: 'archived',
        pinned: false,
        revision: 2,
        contentRevision: 1,
        mainQuestion: question,
        originalQuestion: question,
        tags: [],
        branchId,
        purgeAt: null,
        lastEventSequence: '2',
      });
      const stored = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect(stored.archivedAt).toBeInstanceOf(Date);
      expect(stored.deletedAt).toBeNull();
      expect(stored.contentRevision).toBe(1);
      // Lifecycle changes are activity (the pipeline's one writer of last_activity_at).
      expect(stored.lastActivityAt.getTime()).toBeGreaterThan(before.lastActivityAt.getTime());
      expect(await events(studyId)).toStrictEqual([
        { sequence: '1', eventType: 'study_created', payload: expect.any(Object) },
        { sequence: '2', eventType: 'study_archived', payload: {} },
      ]);

      // Readable as archived; listed only under Archived.
      const read1 = await read(alice, studyId);
      expect([read1.status, (read1.body as StudyResponse).lifecycle]).toStrictEqual([
        200,
        'archived',
      ]);
      expect(await library(alice, 'archived')).toContain(studyId);
      expect(await library(alice, 'active')).not.toContain(studyId);

      const unarchived = await changed(alice, 'unarchive', studyId, 2);
      expect([
        unarchived.lifecycle,
        unarchived.revision,
        unarchived.lastEventSequence,
      ]).toStrictEqual(['active', 3, '3']);
      expect((await Study.findByPk(studyId, { rejectOnEmpty: true })).archivedAt).toBeNull();
      expect((await events(studyId)).at(-1)).toStrictEqual({
        sequence: '3',
        eventType: 'study_unarchived',
        payload: {},
      });
      const edited = await patch(alice, studyId, { expectedRevision: 3, title: 'Conscience' });
      expect(edited.status).toBe(200);
      expect(await library(alice, 'active')).toContain(studyId);
    });

    it('refuses every other study mutation on an archived study with 422 STUDY_ARCHIVED, writing nothing: PATCH and any later mutation route (the BIB-12 probes)', async () => {
      const { studyId, questionNodeId } = await createStudy(alice);
      if (questionNodeId === null) throw new Error('expected a question');
      await changed(alice, 'archive', studyId, 1);
      const before = await ownerRows(alice);

      const key = randomUUID();
      const edit = await patch(alice, studyId, { expectedRevision: 2, title: 'New' }, key);
      expect([edit.status, edit.body]).toStrictEqual([422, STUDY_ARCHIVED]);
      // A stale revision does not change the answer: the state is checked first, under the lock.
      const stale = await patch(alice, studyId, { expectedRevision: 1, pinned: true });
      expect([stale.status, stale.body]).toStrictEqual([422, STUDY_ARCHIVED]);
      const studyLevel = await probe(alice, studyId, { expectedRevision: 2, title: 'Probe' });
      expect([studyLevel.status, studyLevel.body]).toStrictEqual([422, STUDY_ARCHIVED]);
      const childLevel = await probeNode(alice, studyId, questionNodeId);
      expect([childLevel.status, childLevel.body]).toStrictEqual([422, STUDY_ARCHIVED]);
      // Archive again is not a different state: 422, not a second event.
      const again = await change(alice, 'archive', studyId, { expectedRevision: 2 });
      expect([again.status, again.body]).toStrictEqual([422, TRANSITION_INVALID]);

      expect(await ownerRows(alice)).toStrictEqual(before);
      // The refusal was not stored: the same key works once the study is active again.
      await changed(alice, 'unarchive', studyId, 2);
      const retried = await patch(alice, studyId, { expectedRevision: 3, title: 'New' }, key);
      expect(retried.status).toBe(200);
    });
  });

  describe('trash and restore', () => {
    it('trashes an active study and restores it within the recovery window with its nodes, events and branch intact', async () => {
      const { studyId, questionNodeId } = await createStudy(alice, {
        question: 'What is conscience?',
      });
      await patch(alice, studyId, { expectedRevision: 1, pinned: true, tags: { add: ['Romans'] } });
      const beforeRead = (await read(alice, studyId)).body as StudyResponse;
      const nodesBefore = await StudyNode.findAll({ where: { studyId }, raw: true });
      const branchesBefore = await StudyBranch.findAll({ where: { studyId }, raw: true });

      const res = await change(alice, 'trash', studyId, { expectedRevision: 2 });
      const stored = await Study.findByPk(studyId, { rejectOnEmpty: true });
      if (stored.deletedAt === null) throw new Error('expected deleted_at');
      const purgeAt = new Date(stored.deletedAt.getTime() + 30 * DAY_MS).toISOString();
      const { startingReference: _ref, createdAt: _created, ...state } = beforeRead;
      expect([res.status, res.body]).toStrictEqual([
        200,
        {
          ...state,
          lifecycle: 'trashed',
          revision: 3,
          purgeAt,
          lastEventSequence: '4',
        },
      ]);
      expect(stored.archivedAt).toBeNull();
      expect((await events(studyId)).at(-1)).toStrictEqual({
        sequence: '4',
        eventType: 'study_trashed',
        payload: {},
      });

      // The owner can still open it, with its purge date; it is listed only in Trash.
      const opened = await read(alice, studyId);
      expect([opened.status, opened.body]).toStrictEqual([
        200,
        { ...beforeRead, lifecycle: 'trashed', revision: 3, purgeAt },
      ]);
      expect(await library(alice, 'trashed')).toContain(studyId);
      expect(await library(alice, 'active')).not.toContain(studyId);
      expect(await library(alice, 'archived')).not.toContain(studyId);

      // Every other change, the lifecycle ones included, is STUDY_TRASHED.
      for (const transition of ['archive', 'unarchive', 'trash'] as const) {
        const refused = await change(alice, transition, studyId, { expectedRevision: 3 });
        expect([transition, refused.status, refused.body]).toStrictEqual([
          transition,
          422,
          STUDY_TRASHED,
        ]);
      }
      const edit = await patch(alice, studyId, { expectedRevision: 3, title: 'x' });
      expect([edit.status, edit.body]).toStrictEqual([422, STUDY_TRASHED]);
      if (questionNodeId === null) throw new Error('expected a question');
      const child = await probeNode(alice, studyId, questionNodeId);
      expect([child.status, child.body]).toStrictEqual([422, STUDY_TRASHED]);

      const restored = await change(alice, 'restore', studyId, { expectedRevision: 3 });
      expect([restored.status, restored.body]).toStrictEqual([
        200,
        { ...state, revision: 4, lastEventSequence: '5' },
      ]);
      expect((await events(studyId)).at(-1)).toStrictEqual({
        sequence: '5',
        eventType: 'study_restored',
        payload: { restoredTo: 'active' },
      });
      expect((await read(alice, studyId)).body).toStrictEqual({ ...beforeRead, revision: 4 });
      expect(await StudyNode.findAll({ where: { studyId }, raw: true })).toStrictEqual(nodesBefore);
      expect(await StudyBranch.findAll({ where: { studyId }, raw: true })).toStrictEqual(
        branchesBefore,
      );
      expect((await events(studyId)).map((e) => e.sequence)).toStrictEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
      ]);
      expect(await library(alice, 'active')).toContain(studyId);
      expect(await library(alice, 'trashed')).not.toContain(studyId);
    });

    it('restores a study trashed from the archive back to archived', async () => {
      const { studyId } = await createStudy(alice);
      await changed(alice, 'archive', studyId, 1);
      const archivedAt = (await Study.findByPk(studyId, { rejectOnEmpty: true })).archivedAt;
      const trashed = await changed(alice, 'trash', studyId, 2);
      expect(trashed.lifecycle).toBe('trashed');
      expect((await Study.findByPk(studyId, { rejectOnEmpty: true })).archivedAt).toStrictEqual(
        archivedAt,
      );
      const restored = await changed(alice, 'restore', studyId, 3);
      expect([restored.lifecycle, restored.purgeAt]).toStrictEqual(['archived', null]);
      const stored = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect([stored.archivedAt, stored.deletedAt]).toStrictEqual([archivedAt, null]);
      expect((await events(studyId)).at(-1)?.payload).toStrictEqual({ restoredTo: 'archived' });
    });

    it('refuses transitions the current state does not start from with 422 LIFECYCLE_TRANSITION_INVALID, writing nothing', async () => {
      const { studyId } = await createStudy(alice);
      const before = await ownerRows(alice);
      for (const transition of ['unarchive', 'restore'] as const) {
        const res = await change(alice, transition, studyId, { expectedRevision: 1 });
        expect([transition, res.status, res.body]).toStrictEqual([
          transition,
          422,
          TRANSITION_INVALID,
        ]);
      }
      expect(await ownerRows(alice)).toStrictEqual(before);
    });
  });

  describe('revisions, validation and idempotency', () => {
    it('needs expectedRevision (428), refuses any other body field (400), and answers a stale revision with 409', async () => {
      const { studyId } = await createStudy(alice);
      const before = await ownerRows(alice);
      for (const transition of ['archive', 'trash'] as const) {
        const missing = await change(alice, transition, studyId, {});
        expect([missing.status, missing.body]).toStrictEqual([428, REVISION_MISSING]);
        const extra = await change(alice, transition, studyId, {
          expectedRevision: 1,
          lifecycle: 'archived',
        });
        expect([extra.status, extra.body]).toStrictEqual([
          400,
          envelope({
            code: 'VALIDATION',
            message: 'Invalid request',
            fieldErrors: { _: ['Unrecognized key: "lifecycle"'] },
          }),
        ]);
        const stale = await change(alice, transition, studyId, { expectedRevision: 7 });
        expect([stale.status, stale.body]).toStrictEqual([409, conflict(1)]);
      }
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('replays a retry with the same Idempotency-Key and body, and refuses the key with another body', async () => {
      const { studyId } = await createStudy(alice);
      const key = randomUUID();
      const first = await change(alice, 'archive', studyId, { expectedRevision: 1 }, key);
      expect(first.status).toBe(200);
      const replay = await change(alice, 'archive', studyId, { expectedRevision: 1 }, key);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toStrictEqual([
        200,
        'true',
        first.body,
      ]);
      expect((await events(studyId)).map((e) => e.eventType)).toStrictEqual([
        'study_created',
        'study_archived',
      ]);
      const reused = await change(alice, 'unarchive', studyId, { expectedRevision: 2 }, key);
      expect([reused.status, reused.body]).toStrictEqual([422, KEY_REUSED]);
    });

    it('serializes an archive and an edit racing on one revision: exactly one commits, the other is refused', async () => {
      const { studyId } = await createStudy(alice);
      const gate = await db.transaction();
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [studyId],
        transaction: gate,
      });
      const pending = [
        change(alice, 'archive', studyId, { expectedRevision: 1 }),
        patch(alice, studyId, { expectedRevision: 1, title: 'Racing edit' }),
      ];
      // Both wait on the gate's row lock, then contend.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'`,
          { type: QueryTypes.SELECT },
        );
        if ((row?.n ?? 0) >= 2) break;
        if (Date.now() > deadline) throw new Error('racers never blocked on the gate');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await gate.rollback();
      const [archive, edit] = await Promise.all(pending);
      // Whichever takes the study lock first wins. An edit that loses meets an archived study
      // (422, checked before the revision); an archive that loses meets a new revision (409).
      expect([archive?.status, edit?.status, edit?.body]).toStrictEqual(
        archive?.status === 200 ? [200, 422, STUDY_ARCHIVED] : [409, 200, expect.any(Object)],
      );
      expect((await Study.findByPk(studyId, { rejectOnEmpty: true })).revision).toBe(2);
      expect(await StudyEvent.count({ where: { studyId } })).toBe(2);
    });
  });

  describe('owner isolation', () => {
    /**
     * Bob calls a lifecycle route on Alice's study (in a state the transition starts from, so only
     * ownership decides), on an absent id and on a malformed one; then without a session. Returns
     * every answer plus whether either owner's rows changed, for one whole-body assertion.
     */
    async function crossUserAnswers(transition: Transition, path: (studyId: string) => string) {
      const { studyId } = await createStudy(alice);
      if (transition === 'unarchive') await changed(alice, 'archive', studyId, 1);
      if (transition === 'restore') await changed(alice, 'trash', studyId, 1);
      const revision = (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const answers = [
        await change(bob, transition, studyId, { expectedRevision: revision }),
        await change(bob, transition, randomUUID(), { expectedRevision: 1 }),
        await change(bob, transition, 'not-a-uuid', { expectedRevision: 1 }),
        await request(app.getHttpServer())
          [transition === 'trash' ? 'delete' : 'post'](path(studyId))
          .send({ expectedRevision: revision }),
        // Another user's archived or trashed study is the same 404 to read, too.
        await read(bob, studyId),
      ];
      return {
        answers: answers.map((res): unknown[] => [res.status, res.body]),
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), aliceBefore),
        bobUnchanged: isDeepStrictEqual(await ownerRows(bob), bobBefore),
      };
    }

    const CROSS_USER_ANSWERS = {
      answers: [
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [401, UNAUTHENTICATED],
        [404, NOT_FOUND],
      ],
      aliceUnchanged: true,
      bobUnchanged: true,
    };

    it('POST /v1/studies/:studyId/archive gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(await crossUserAnswers('archive', archivePath)).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('POST /v1/studies/:studyId/unarchive gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(await crossUserAnswers('unarchive', unarchivePath)).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('DELETE /v1/studies/:studyId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(await crossUserAnswers('trash', studyPath)).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('POST /v1/studies/:studyId/restore gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(await crossUserAnswers('restore', restorePath)).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });

  describe('the Trash listing', () => {
    it("pages only the owner's trashed studies with purge dates and sealed cursors that no other listing or user accepts", async () => {
      const dana = await signedInUser();
      const first = await createStudy(dana, { title: 'First trashed', blank: true });
      const second = await createStudy(dana, { title: 'Second trashed', blank: true });
      await createStudy(dana, { title: 'Still active', blank: true });
      const trashedFirst = await changed(dana, 'trash', first.studyId, 1);
      const trashedSecond = await changed(dana, 'trash', second.studyId, 1);
      const list = (owner: Owner, query: Record<string, string>) =>
        request(app.getHttpServer())
          .get(STUDIES)
          .query(query)
          .set('Cookie', owner.cookie)
          .then((res) => res);
      const item = (body: StudyLifecycleResponse, studyId: string) => ({
        id: studyId,
        title: body.title,
        pinned: false,
        lifecycle: 'trashed',
        startingReference: null,
        tags: [],
        lastActivityAt: expect.any(String),
        createdAt: expect.any(String),
        purgeAt: body.purgeAt,
      });
      const trashQuery = { state: 'trashed', sort: 'recent', pinnedFirst: 'false', limit: '1' };

      const page1 = await list(dana, trashQuery);
      expect([page1.status, page1.body]).toStrictEqual([
        200,
        { items: [item(trashedSecond, second.studyId)], nextCursor: expect.any(String) },
      ]);
      const cursor = (page1.body as StudyListResponse).nextCursor ?? '';
      const page2 = await list(dana, { ...trashQuery, cursor });
      expect([page2.status, page2.body]).toStrictEqual([
        200,
        { items: [item(trashedFirst, first.studyId)], nextCursor: null },
      ]);

      // The cursor is sealed to this owner and this listing: the Active view or Bob gets 400.
      const invalidCursor = envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { cursor: ['Invalid cursor'] },
      });
      const otherState = await list(dana, { ...trashQuery, state: 'active', cursor });
      const otherUser = await list(bob, { ...trashQuery, cursor });
      const bobsTrash = await list(bob, { state: 'trashed', pinnedFirst: 'false' });
      expect([otherState, otherUser].map((res): unknown[] => [res.status, res.body])).toStrictEqual(
        [
          [400, invalidCursor],
          [400, invalidCursor],
        ],
      );
      expect((bobsTrash.body as StudyListResponse).items.map((i) => i.id)).not.toContain(
        first.studyId,
      );
    });
  });

  describe('the 30-day recovery window', () => {
    it('makes a study trashed 30 or more days ago absent everywhere: read, restore, edit and the Trash listing', async () => {
      const { studyId, questionNodeId } = await createStudy(alice);
      await changed(alice, 'trash', studyId, 1);

      // A day before the end of the window it is still restorable and listed.
      await trashedDaysAgo(studyId, 29);
      expect((await read(alice, studyId)).status).toBe(200);
      expect(await library(alice, 'trashed')).toContain(studyId);

      await trashedDaysAgo(studyId, 30, 1000);
      const before = await ownerRows(alice);
      const reads = [
        await read(alice, studyId),
        await change(alice, 'restore', studyId, { expectedRevision: 2 }),
        await patch(alice, studyId, { expectedRevision: 2, title: 'x' }),
        await change(alice, 'archive', studyId, { expectedRevision: 2 }),
      ];
      expect(reads.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
      expect(await library(alice, 'trashed')).not.toContain(studyId);
      expect(await ownerRows(alice)).toStrictEqual(before);
      // StudyAccessService fails closed for the study and its children alike.
      const access = app.get(StudyAccessService);
      const answers = await Promise.all([
        access.requireOwnedStudy(alice.user.id, studyId).catch((e: unknown) => e),
        access
          .requireOwnedNode(alice.user.id, studyId, questionNodeId ?? '')
          .catch((e: unknown) => e),
      ]);
      expect(answers.map((e) => e instanceof NotFoundError)).toStrictEqual([true, true]);
    });
  });

  describe('purge', () => {
    it('hard-deletes only studies past their recovery window, with every row of theirs, their unused tags and their owners’ expired receipts', async () => {
      const carol = await signedInUser();
      // Expired: a tagged study with an expired receipt about it.
      const expired = await createStudy(carol, { question: 'Expired study' });
      const sharedTag = `shared-${randomUUID()}`;
      const ownTag = `own-${randomUUID()}`;
      const tagKey = randomUUID();
      const tagged = await patch(
        carol,
        expired.studyId,
        { expectedRevision: 1, tags: { add: [sharedTag, ownTag] } },
        tagKey,
      );
      expect(tagged.status).toBe(200);
      await changed(carol, 'trash', expired.studyId, 2);
      await trashedDaysAgo(expired.studyId, 31);
      // In the window: kept. Active, sharing a tag: kept, and so is that tag.
      const recent = await createStudy(carol, { question: 'Recently trashed' });
      await changed(carol, 'trash', recent.studyId, 1);
      const live = await createStudy(carol, { question: 'Live study' });
      await patch(carol, live.studyId, { expectedRevision: 1, tags: { add: [sharedTag] } });
      // Receipts: the tag edit's (expired), and a live one.
      const liveKey = randomUUID();
      await patch(carol, live.studyId, { expectedRevision: 2, pinned: true }, liveKey);
      await MutationReceipt.update(
        { createdAt: new Date(Date.now() - 8 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) },
        { where: { ownerId: carol.user.id, idempotencyKey: tagKey } },
      );
      // Another owner's expired study is purged too; their live data stays.
      const bobs = await createStudy(bob, { question: 'Bob study' });
      const bobsTrashed = await createStudy(bob, { question: 'Bob trashed' });
      await changed(bob, 'trash', bobsTrashed.studyId, 1);
      await trashedDaysAgo(bobsTrashed.studyId, 40);

      // Every study past its window is due, including earlier tests' (the purge is global).
      const [due] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM study
          WHERE lifecycle = 'trashed' AND deleted_at <= now() - interval '30 days'`,
        { type: QueryTypes.SELECT },
      );
      expect(due?.n).toBeGreaterThanOrEqual(2);
      const logged = vi.spyOn(Logger.prototype, 'log');
      const purged = await app.get(StudyTrashPurgeService).purgeExpired();
      expect(purged).toBe(due?.n);
      // One content-free line per run: counts and duration only.
      expect(logged.mock.calls).toStrictEqual([
        ['trash_purged', { studies: purged, durationMs: expect.any(Number) }],
      ]);
      logged.mockRestore();

      const gone = [expired.studyId, bobsTrashed.studyId];
      expect(
        await Promise.all([
          Study.count({ where: { id: gone } }),
          StudyNode.count({ where: { studyId: gone } }),
          StudyEvent.count({ where: { studyId: gone } }),
          StudyBranch.count({ where: { studyId: gone } }),
          StudyTag.count({ where: { studyId: gone } }),
        ]),
      ).toStrictEqual([0, 0, 0, 0, 0]);
      const carolTags = await Tag.findAll({ where: { ownerId: carol.user.id }, raw: true });
      expect(carolTags.map((tag) => tag.name)).toStrictEqual([sharedTag]);
      expect(
        (await MutationReceipt.findAll({ where: { ownerId: carol.user.id }, raw: true })).map(
          (receipt) => receipt.idempotencyKey,
        ),
      ).toStrictEqual([liveKey]);
      expect(
        (await Study.findAll({ where: { id: [recent.studyId, live.studyId, bobs.studyId] } }))
          .map((study) => study.id)
          .sort(),
      ).toStrictEqual([recent.studyId, live.studyId, bobs.studyId].sort());

      // Idempotent: nothing more is due.
      expect(await app.get(StudyTrashPurgeService).purgeExpired()).toBe(0);
    });
  });
});
