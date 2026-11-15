import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateStudyResponse,
  RecordActivityResponse,
  ResolveReferenceResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudySession } from '../src/database/models/study-session.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anyId: unknown = expect.stringMatching(UUID);
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);
const TAB = 'X-Tab-Instance-Id';
const MINUTE = 60 * 1000;

// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const activityPath = (studyId: string): string => `/v1/studies/${studyId}/activity`;
const endSessionPath = (studyId: string): string => `/v1/studies/${studyId}/sessions/end`;

/** BIB-33: study sessions per browser tab. Real PostgreSQL. */
describe('study sessions (BIB-33)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  let romans: ScriptureReference;
  const userIds: string[] = [];

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
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path);
    if (owner) req = req.set('Cookie', owner.cookie);
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  async function createStudy(owner: Owner, tab?: string) {
    const res = await send(
      owner,
      'post',
      '/v1/studies',
      { question: 'What does conscience witness?' },
      tab ? { [TAB]: tab } : {},
    );
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  async function visit(owner: Owner, studyId: string, tab: string | null) {
    const res = await send(
      owner,
      'post',
      activityPath(studyId),
      {
        kind: 'visit',
        clientMutationId: randomUUID(),
        referenceId: romans.id,
        origin: { kind: 'search' },
      },
      tab ? { [TAB]: tab } : {},
    );
    expect(res.status).toBe(201);
    return res.body as RecordActivityResponse;
  }

  async function sessions(studyId: string) {
    const rows = await StudySession.findAll({
      where: { studyId },
      order: [
        ['startedAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return rows.map((row) => ({
      id: row.id,
      tabInstanceId: row.tabInstanceId,
      endedAt: row.endedAt,
      endReason: row.endReason,
      lastVisitEventId: row.lastVisitEventId,
      activeBranchId: row.activeBranchId,
    }));
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((row) => ({ id: row.id, type: row.eventType, sessionId: row.sessionId }));
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const res = await send(alice, 'post', '/v1/bible/resolve', {
      input: 'Romans 8:16',
      editionId: edition.id,
    });
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    romans = body.reference;
  });

  afterAll(async () => {
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  it('starts a session on the first meaningful action of a tab, keeps the tab in it, and gives a second tab its own session sharing the study revision', async () => {
    const tabA = randomUUID();
    const tabB = randomUUID();
    const { studyId, revision, branchId } = await createStudy(alice, tabA);
    const first = await visit(alice, studyId, tabA);
    const second = await visit(alice, studyId, tabA);
    // A content edit from tab B, checked against the same study revision tab A saw.
    const node = await send(
      alice,
      'post',
      `/v1/studies/${studyId}/nodes`,
      { expectedRevision: revision, type: 'thought', text: 'Witness with our spirit' },
      { [TAB]: tabB },
    );
    expect(node.status).toBe(201);

    const rows = await sessions(studyId);
    expect(rows).toStrictEqual([
      {
        id: anyId,
        tabInstanceId: tabA,
        endedAt: null,
        endReason: null,
        lastVisitEventId: second.eventId,
        activeBranchId: branchId,
      },
      {
        id: anyId,
        tabInstanceId: tabB,
        endedAt: null,
        endReason: null,
        lastVisitEventId: null,
        activeBranchId: null,
      },
    ]);
    const [a, b] = rows;
    expect(await events(studyId)).toStrictEqual([
      { id: anyId, type: 'session_started', sessionId: a?.id },
      { id: anyId, type: 'study_created', sessionId: a?.id },
      { id: first.eventId, type: 'scripture_opened', sessionId: a?.id },
      { id: second.eventId, type: 'scripture_opened', sessionId: a?.id },
      { id: anyId, type: 'session_started', sessionId: b?.id },
      { id: anyId, type: 'thought_created', sessionId: b?.id },
    ]);
  });

  it('records no session for a request without a tab id', async () => {
    const { studyId } = await createStudy(alice);
    await visit(alice, studyId, null);
    expect(await sessions(studyId)).toStrictEqual([]);
    expect((await events(studyId)).map((event) => event.sessionId)).toStrictEqual([null, null]);
  });

  it('begins a new session after more than 30 minutes idle, closing the old one without rewriting its events', async () => {
    const tab = randomUUID();
    const { studyId } = await createStudy(alice, tab);
    const before = await visit(alice, studyId, tab);
    const [old] = await sessions(studyId);
    if (!old) throw new Error('expected a session');
    const eventsBefore = await events(studyId);
    // The tab went quiet 31 minutes ago.
    const lastActivity = new Date(Date.now() - 31 * MINUTE);
    await StudySession.update(
      { startedAt: lastActivity, lastMeaningfulActivityAt: lastActivity },
      { where: { id: old.id } },
    );

    const after = await visit(alice, studyId, tab);

    const rows = await sessions(studyId);
    expect(rows).toHaveLength(2);
    const ended = await StudySession.findByPk(old.id, { rejectOnEmpty: true });
    expect(ended.endReason).toBe('inactivity');
    expect(ended.endedAt?.getTime()).toBe(lastActivity.getTime() + 30 * MINUTE);
    const fresh = rows.find((row) => row.id !== old.id);
    expect(fresh).toMatchObject({
      tabInstanceId: tab,
      endedAt: null,
      lastVisitEventId: after.eventId,
    });
    // Earlier events keep their session; the new ones are appended.
    expect(await events(studyId)).toStrictEqual([
      ...eventsBefore,
      { id: anyId, type: 'session_ended', sessionId: old.id },
      { id: anyId, type: 'session_started', sessionId: fresh?.id },
      { id: after.eventId, type: 'scripture_opened', sessionId: fresh?.id },
    ]);
    expect(eventsBefore.find((event) => event.id === before.eventId)?.sessionId).toBe(old.id);
  });

  it('never starts a session or moves last activity for passive restoration, reads or view-only saves', async () => {
    const { studyId } = await createStudy(alice);
    const tab = randomUUID();
    const headers = { [TAB]: tab };
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });

    for (const path of ['', '/events', '/resume', '/graph', '/nodes']) {
      const res = await send(alice, 'get', `/v1/studies/${studyId}${path}`, undefined, headers);
      expect(res.status).toBe(200);
    }
    const saved = await send(
      alice,
      'patch',
      `/v1/studies/${studyId}/view-state`,
      { expectedRevision: 1, panes: { thread: true } },
      headers,
    );
    expect(saved.status).toBe(200);

    expect(await sessions(studyId)).toStrictEqual([]);
    const after = await Study.findByPk(studyId, { rejectOnEmpty: true });
    expect(after.lastActivityAt).toStrictEqual(study.lastActivityAt);
    expect((await events(studyId)).map((event) => [event.type, event.sessionId])).toStrictEqual([
      ['study_created', null],
      ['view_state_saved', null],
    ]);
  });

  it('ends the tab session on explicit exit, and a second exit writes nothing', async () => {
    const tab = randomUUID();
    const { studyId } = await createStudy(alice, tab);
    const [session] = await sessions(studyId);
    if (!session) throw new Error('expected a session');

    const res = await send(alice, 'post', endSessionPath(studyId), {}, { [TAB]: tab });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ sessionId: session.id, lastEventSequence: anySequence });
    const ended = await StudySession.findByPk(session.id, { rejectOnEmpty: true });
    expect(ended.endReason).toBe('exit');
    const count = await StudyEvent.count({ where: { studyId } });

    const again = await send(alice, 'post', endSessionPath(studyId), {}, { [TAB]: tab });
    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual({ sessionId: null, lastEventSequence: null });
    expect(await StudyEvent.count({ where: { studyId } })).toBe(count);

    // The next meaningful action starts a new session.
    await visit(alice, studyId, tab);
    expect((await sessions(studyId)).filter((row) => row.endedAt === null)).toHaveLength(1);
  });

  it('refuses an exit without a tab id', async () => {
    const { studyId } = await createStudy(alice);
    const res = await send(alice, 'post', endSessionPath(studyId), {});
    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(
      envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { [TAB]: ['Must be a UUID'] },
      }),
    );
  });

  it('POST /v1/studies/:studyId/sessions/end gives another user the same neutral 404 as an absent or malformed study, ending nothing', async () => {
    const tab = randomUUID();
    const { studyId } = await createStudy(alice, tab);
    for (const id of [studyId, randomUUID(), 'not-a-uuid']) {
      const res = await send(bob, 'post', endSessionPath(id), {}, { [TAB]: tab });
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    }
    expect((await sessions(studyId)).map((row) => row.endedAt)).toStrictEqual([null]);
  });
});
