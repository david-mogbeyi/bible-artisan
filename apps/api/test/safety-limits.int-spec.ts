import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { CreateNodeResponse, CreateStudyResponse } from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { AccountStorageService } from '../src/modules/study/account-storage.service';
import {
  DEFAULT_SAFETY_LIMITS,
  SAFETY_LIMITS,
  type SafetyLimits,
} from '../src/modules/study/safety-limits';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const STUDIES = '/v1/studies';
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const limitsPath = (studyId: string): string => `/v1/studies/${studyId}/limits`;
const nodesPath = (studyId: string): string => `/v1/studies/${studyId}/nodes`;
const nodePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}`;

const EVENT_LIMIT = envelope({
  code: 'STUDY_EVENT_LIMIT_REACHED',
  message:
    'This study has reached its history limit of 100,000 events. You can still read, export, archive or delete it; start a new study to continue',
});
const STORAGE_LIMIT = envelope({
  code: 'STORAGE_LIMIT_REACHED',
  message:
    'Your account has reached its storage limit of 500 MB. You can still read, export and delete; delete studies you no longer need to make room',
});

/** BIB-52: safety caps (NFR-SCALE-002). Real PostgreSQL, whole-body assertions. */
describe('safety caps (BIB-52)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  const userIds: string[] = [];
  // Every measurement is fresh, so a test can move the caps under the app.
  const limits: SafetyLimits = { ...DEFAULT_SAFETY_LIMITS, storageMeasureTtlMs: 0 };

  async function signedInUser(): Promise<Owner> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return { user, cookie: `ba_session=${token}` };
  }

  function send(
    owner: Owner | null,
    method: 'get' | 'post' | 'delete',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path);
    if (owner) req = req.set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  async function study(id: string): Promise<Study> {
    return Study.findByPk(id, { rejectOnEmpty: true });
  }

  async function createStudy(owner: Owner): Promise<string> {
    const res = await send(owner, 'post', STUDIES, { blank: true });
    expect(res.status).toBe(201);
    return (res.body as CreateStudyResponse).studyId;
  }

  async function addQuestion(owner: Owner, studyId: string, key?: string): Promise<Response> {
    return send(
      owner,
      'post',
      nodesPath(studyId),
      {
        expectedRevision: (await study(studyId)).revision,
        type: 'question',
        text: 'What is conscience?',
      },
      key,
    );
  }

  async function events(studyId: string): Promise<number> {
    return Number((await study(studyId)).lastEventSequence);
  }

  beforeAll(async () => {
    app = await createTestApp(undefined, {
      override: (builder) => builder.overrideProvider(SAFETY_LIMITS).useValue(limits),
    });
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterEach(() => {
    Object.assign(limits, DEFAULT_SAFETY_LIMITS, { storageMeasureTtlMs: 0 });
  });

  afterAll(async () => {
    // Deleting a user cascades to everything they own.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  it('GET /v1/studies/:studyId/limits returns the study and account usage against each cap', async () => {
    const studyId = await createStudy(alice);
    expect((await addQuestion(alice, studyId)).status).toBe(201);

    const res = await send(alice, 'get', limitsPath(studyId));
    const storage = await app.get(AccountStorageService).measure(alice.user.id);
    expect([res.status, res.body]).toStrictEqual([
      200,
      {
        nodes: { used: 1, limit: 2000, state: 'ok' },
        edges: { used: 0, limit: 6000, state: 'ok' },
        events: { used: await events(studyId), limit: 100_000, state: 'ok' },
        storage: { used: storage, limit: 500 * 1024 * 1024, state: 'ok' },
      },
    ]);
    expect(storage).toBeGreaterThan(0);
  });

  it('GET /v1/studies/:studyId/limits gives another user the same neutral 404 as an absent or malformed id', async () => {
    const studyId = await createStudy(alice);
    const answers = [
      await send(bob, 'get', limitsPath(studyId)),
      await send(bob, 'get', limitsPath(randomUUID())),
      await send(bob, 'get', limitsPath('not-a-uuid')),
      await send(null, 'get', limitsPath(studyId)),
    ];
    expect(answers.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
      [404, NOT_FOUND],
      [404, NOT_FOUND],
      [404, NOT_FOUND],
      [401, UNAUTHENTICATED],
    ]);
  });

  it('warns from 80% of a cap and still accepts additions', async () => {
    const studyId = await createStudy(alice);
    for (let i = 0; i < 4; i += 1) expect((await addQuestion(alice, studyId)).status).toBe(201);
    const used = await events(studyId);
    // At least 5 events, so used / (used + 1) is from 80% and below the cap.
    limits.maxEventsPerStudy = used + 1;
    limits.maxAccountStorageBytes = Math.ceil(
      (await app.get(AccountStorageService).measure(alice.user.id)) * 1.1,
    );
    const res = await send(alice, 'get', limitsPath(studyId));
    const body = res.body as Record<string, { state: string; limit: number }>;
    expect([used >= 5, body.events, body.storage?.state]).toStrictEqual([
      true,
      { used, limit: used + 1, state: 'warning' },
      'warning',
    ]);
    expect((await addQuestion(alice, studyId)).status).toBe(201);
  });

  it('at the event cap refuses additions with 422 but keeps reading, export, removal and trash, and replays a committed retry', async () => {
    const studyId = await createStudy(alice);
    const key = randomUUID();
    const first = await addQuestion(alice, studyId, key);
    expect(first.status).toBe(201);
    const nodeId = (first.body as CreateNodeResponse).id;
    const atCap = await events(studyId);
    limits.maxEventsPerStudy = atCap;

    const refused = await addQuestion(alice, studyId);
    expect([refused.status, refused.body, await events(studyId)]).toStrictEqual([
      422,
      EVENT_LIMIT,
      atCap,
    ]);
    // A retry of the request that committed before the cap replays its response.
    const retried = await send(
      alice,
      'post',
      nodesPath(studyId),
      { expectedRevision: 1, type: 'question', text: 'What is conscience?' },
      key,
    );
    expect([retried.status, retried.body, retried.headers['idempotent-replayed']]).toStrictEqual([
      201,
      first.body,
      'true',
    ]);

    const read = await send(alice, 'get', limitsPath(studyId));
    expect([read.status, (read.body as { events: unknown }).events]).toStrictEqual([
      200,
      { used: atCap, limit: atCap, state: 'reached' },
    ]);
    expect(
      (await send(alice, 'post', `/v1/studies/${studyId}/exports`, { format: 'json' })).status,
    ).toBe(201);
    const node = await StudyNode.findByPk(nodeId, { rejectOnEmpty: true });
    expect(
      (await send(alice, 'delete', nodePath(studyId, nodeId), { expectedRevision: node.revision }))
        .status,
    ).toBe(200);
    expect(
      (
        await send(alice, 'delete', `/v1/studies/${studyId}`, {
          expectedRevision: (await study(studyId)).revision,
        })
      ).status,
    ).toBe(200);
  });

  it('at the storage cap refuses a new study and additions with 422 but keeps removal', async () => {
    const studyId = await createStudy(alice);
    const added = await addQuestion(alice, studyId);
    expect(added.status).toBe(201);
    const nodeId = (added.body as CreateNodeResponse).id;
    limits.maxAccountStorageBytes = 1;
    const before = await Study.count({ where: { ownerId: alice.user.id } });

    const newStudy = await send(alice, 'post', STUDIES, { blank: true });
    const addition = await addQuestion(alice, studyId);
    expect([
      newStudy.status,
      newStudy.body,
      addition.status,
      addition.body,
      await Study.count({ where: { ownerId: alice.user.id } }),
    ]).toStrictEqual([422, STORAGE_LIMIT, 422, STORAGE_LIMIT, before]);

    const node = await StudyNode.findByPk(nodeId, { rejectOnEmpty: true });
    expect(
      (await send(alice, 'delete', nodePath(studyId, nodeId), { expectedRevision: node.revision }))
        .status,
    ).toBe(200);
    // Another account is not affected by Alice's storage.
    limits.maxAccountStorageBytes = DEFAULT_SAFETY_LIMITS.maxAccountStorageBytes;
    expect((await send(bob, 'post', STUDIES, { blank: true })).status).toBe(201);
  });

  it('does not count studies in the trash toward account storage', async () => {
    const owner = await signedInUser();
    const studyId = await createStudy(owner);
    const storage = app.get(AccountStorageService);
    expect(await storage.measure(owner.user.id)).toBeGreaterThan(0);
    expect(
      (
        await send(owner, 'delete', `/v1/studies/${studyId}`, {
          expectedRevision: (await study(studyId)).revision,
        })
      ).status,
    ).toBe(200);
    // Only owner-level rows (the mutation receipts and tags tables, empty here) remain.
    expect(await storage.measure(owner.user.id)).toBe(0);
  });
});
