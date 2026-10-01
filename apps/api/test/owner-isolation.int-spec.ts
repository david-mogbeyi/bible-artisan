import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { StudyAccessService } from '../src/modules/study/study-access.service';
import { createTestApp } from './app';
import { OwnerIsolationProbeModule } from './support/owner-isolation-probe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = {
  code: 'NOT_FOUND',
  message: 'Resource not found',
  retryable: false,
  correlationId: expect.stringMatching(UUID),
};
const UNAUTHENTICATED = {
  code: 'UNAUTHENTICATED',
  message: 'Sign in to continue',
  retryable: false,
  correlationId: expect.stringMatching(UUID),
};

interface Owner {
  user: User;
  cookie: string;
}

/**
 * NFR-SEC-001 cross-user matrix. Runs against test-only probe routes that use the real session
 * guard, `@CurrentUserId()`, `ParseResourceIdPipe`, and `StudyAccessService` (no real
 * study-scoped route exists yet). Every non-owner case must be indistinguishable from an absent
 * resource: same status, same body apart from the per-request correlationId.
 */
describe('owner isolation for private study-scoped resources', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let access: StudyAccessService;
  let alice: Owner;
  let bob: Owner;
  let aliceStudy: Study;
  let aliceOtherStudy: Study;
  let aliceNode: StudyNode;
  let aliceDeletedNode: StudyNode;
  let bobStudy: Study;
  let bobNode: StudyNode;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const get = (path: string, owner?: Owner) => {
    const req = http().get(path);
    return owner ? req.set('Cookie', owner.cookie) : req;
  };
  const studyPath = (studyId: string): string => `/v1/__test/studies/${studyId}`;
  const nodePath = (studyId: string, nodeId: string): string =>
    `/v1/__test/studies/${studyId}/nodes/${nodeId}`;

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    const sessions = app.get(SessionService);
    const { token } = await db.transaction((transaction) => sessions.create(user.id, transaction));
    return { user, cookie: `ba_session=${token}` };
  }

  beforeAll(async () => {
    app = await createTestApp(OwnerIsolationProbeModule);
    db = app.get<Database>(DATABASE);
    access = app.get(StudyAccessService);
    alice = await signedInUser();
    bob = await signedInUser();
    aliceStudy = await Study.create({ ownerId: alice.user.id, title: 'Conscience' });
    aliceOtherStudy = await Study.create({ ownerId: alice.user.id, title: 'Spirit' });
    bobStudy = await Study.create({ ownerId: bob.user.id, title: 'Grace' });
    aliceNode = await StudyNode.create({
      studyId: aliceStudy.id,
      ownerId: alice.user.id,
      type: 'question',
    });
    aliceDeletedNode = await StudyNode.create({
      studyId: aliceStudy.id,
      ownerId: alice.user.id,
      type: 'question',
      deletedAt: new Date(),
    });
    bobNode = await StudyNode.create({ studyId: bobStudy.id, ownerId: bob.user.id, type: 'note' });
  });

  afterAll(async () => {
    const userIds = [alice.user.id, bob.user.id];
    await StudyNode.destroy({ where: { ownerId: userIds } });
    await Study.destroy({ where: { ownerId: userIds } });
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('the owner', () => {
    it('reads their own study', async () => {
      const res = await get(studyPath(aliceStudy.id), alice).expect(200);
      expect(res.body).toStrictEqual({ studyId: aliceStudy.id });
    });

    it('reads their own live node', async () => {
      const res = await get(nodePath(aliceStudy.id, aliceNode.id), alice).expect(200);
      expect(res.body).toStrictEqual({ studyId: aliceStudy.id, nodeId: aliceNode.id });
    });

    it("cannot reach their node through their other study's ID", async () => {
      const res = await get(nodePath(aliceOtherStudy.id, aliceNode.id), alice).expect(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    });

    it('cannot read a soft-deleted node', async () => {
      const res = await get(nodePath(aliceStudy.id, aliceDeletedNode.id), alice).expect(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    });
  });

  describe("another user (Bob) addressing Alice's resources", () => {
    it.each([
      ['her study', () => studyPath(aliceStudy.id)],
      ['her node', () => nodePath(aliceStudy.id, aliceNode.id)],
      ['her node under his own study', () => nodePath(bobStudy.id, aliceNode.id)],
      ['his own node under her study', () => nodePath(aliceStudy.id, bobNode.id)],
    ])('gets the neutral 404 for %s', async (_, path) => {
      const res = await get(path(), bob).expect(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    });

    it('gets exactly the body an absent ID gets (no existence signal)', async () => {
      const foreign = await get(nodePath(aliceStudy.id, aliceNode.id), bob).expect(404);
      const absent = await get(nodePath(randomUUID(), randomUUID()), bob).expect(404);
      const { correlationId: _foreignId, ...foreignBody } = foreign.body as Record<string, unknown>;
      const { correlationId: _absentId, ...absentBody } = absent.body as Record<string, unknown>;
      expect(foreignBody).toStrictEqual(absentBody);
      expect(Object.keys(foreign.headers).sort()).toStrictEqual(Object.keys(absent.headers).sort());
    });
  });

  describe('absent and malformed IDs', () => {
    it.each([
      ['absent study', () => studyPath(randomUUID())],
      ['absent node', () => nodePath(aliceStudy.id, randomUUID())],
      ['non-UUID study ID', () => studyPath('not-a-uuid')],
      ['non-UUID node ID', () => nodePath(aliceStudy.id, 'not-a-uuid')],
      ['numeric study ID', () => studyPath('1')],
      ['SQL-looking node ID', () => nodePath(aliceStudy.id, "1'%20OR%20'1'='1")],
    ])('%s gets the same neutral 404', async (_, path) => {
      const res = await get(path(), alice).expect(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    });
  });

  it('requires a session (401) before any ownership lookup', async () => {
    const res = await get(nodePath(aliceStudy.id, aliceNode.id)).expect(401);
    expect(res.body).toStrictEqual(UNAUTHENTICATED);
  });

  it('GET /v1/me returns only the signed-in user', async () => {
    const forAlice = await get('/v1/me', alice).expect(200);
    expect(forAlice.body).toStrictEqual({
      id: alice.user.id,
      email: alice.user.normalizedEmail,
      displayName: null,
      timezone: 'UTC',
    });
    const forBob = await get('/v1/me', bob).expect(200);
    expect(forBob.body).toStrictEqual({
      id: bob.user.id,
      email: bob.user.normalizedEmail,
      displayName: null,
      timezone: 'UTC',
    });
  });

  describe('StudyAccessService inside a write transaction', () => {
    it('loads and locks owned rows', async () => {
      const ids = await db.transaction(async (transaction) => {
        const study = await access.requireOwnedStudy(alice.user.id, aliceStudy.id, {
          transaction,
          lock: true,
        });
        const node = await access.requireOwnedNode(alice.user.id, aliceStudy.id, aliceNode.id, {
          transaction,
          lock: true,
        });
        return { studyId: study.id, nodeId: node.id };
      });
      expect(ids).toStrictEqual({ studyId: aliceStudy.id, nodeId: aliceNode.id });
    });

    it("throws NotFoundError for another owner's rows inside a transaction", async () => {
      await expect(
        db.transaction((transaction) =>
          access.requireOwnedStudy(bob.user.id, aliceStudy.id, { transaction, lock: true }),
        ),
      ).rejects.toThrow(NotFoundError);
      await expect(
        db.transaction((transaction) =>
          access.requireOwnedNode(bob.user.id, aliceStudy.id, aliceNode.id, { transaction }),
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it('fails closed on non-UUID IDs without querying', async () => {
      await expect(access.requireOwnedStudy(alice.user.id, 'nope')).rejects.toThrow(NotFoundError);
      await expect(access.requireOwnedNode(alice.user.id, aliceStudy.id, 'nope')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('refuses a lock without a transaction (it would protect nothing)', async () => {
      await expect(
        access.requireOwnedStudy(alice.user.id, aliceStudy.id, { lock: true }),
      ).rejects.toThrow('StudyAccessService: lock requires a transaction');
    });
  });
});
