import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateNodeResponse,
  CreateStudyResponse,
  RecordActivityResponse,
  ResolveReferenceResponse,
  ResumeResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { StudyViewState } from '../src/database/models/study-view-state.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const anyTime: unknown = expect.stringMatching(ISO);
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);
const DAY = 24 * 60 * 60 * 1000;

// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const resumePath = (studyId: string): string => `/v1/studies/${studyId}/resume`;
const viewStatePath = (studyId: string): string => `/v1/studies/${studyId}/view-state`;

const REVISION_MISSING = envelope({
  code: 'REVISION_MISSING',
  message: 'expectedRevision is required',
});
const conflict = (currentRevision: number) =>
  envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision });

/** BIB-34: saved workspace context and deterministic resume. Real PostgreSQL, no AI. */
describe('deterministic resume (BIB-34)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  let romans: ScriptureReference;
  let john: ScriptureReference;
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

  async function resolve(input: string): Promise<ScriptureReference> {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const res = await send(alice, 'post', '/v1/bible/resolve', { input, editionId: edition.id });
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  const QUESTION = 'What does conscience witness?';

  async function createStudy(owner: Owner) {
    const res = await send(owner, 'post', '/v1/studies', {
      question: QUESTION,
      startingReferenceId: romans.id,
    });
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  async function addNode(
    studyId: string,
    type: 'question' | 'conclusion' | 'thought',
    text: string,
  ) {
    const res = await send(alice, 'post', `/v1/studies/${studyId}/nodes`, {
      expectedRevision: await studyRevision(studyId),
      type,
      text,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  async function visit(studyId: string, referenceId: string) {
    const res = await send(alice, 'post', `/v1/studies/${studyId}/activity`, {
      kind: 'visit',
      clientMutationId: randomUUID(),
      referenceId,
      origin: { kind: 'search' },
    });
    expect(res.status).toBe(201);
    return res.body as RecordActivityResponse;
  }

  async function viewRevision(studyId: string): Promise<number> {
    return (await StudyViewState.findOne({ where: { studyId } }))?.revision ?? 1;
  }

  async function saveView(studyId: string, body: object) {
    const res = await send(alice, 'patch', viewStatePath(studyId), {
      expectedRevision: await viewRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(200);
    return res;
  }

  async function resume(studyId: string): Promise<ResumeResponse> {
    const res = await send(alice, 'get', resumePath(studyId));
    expect(res.status).toBe(200);
    return res.body as ResumeResponse;
  }

  async function softDelete(nodeId: string) {
    await StudyNode.update({ deletedAt: new Date() }, { where: { id: nodeId } });
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    romans = await resolve('Romans 9:1');
    john = await resolve('John 3:16');
  });

  afterAll(async () => {
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  it('restores the saved question, branch and passage after four days in one read, with no AI', async () => {
    const { studyId, questionNodeId, branchId } = await createStudy(alice);
    const conclusionId = await addNode(studyId, 'conclusion', 'Conscience bears witness');
    const followUpId = await addNode(studyId, 'question', 'Whose witness is it?');
    const visited = await visit(studyId, john.id);
    await saveView(studyId, { selectedNodeId: followUpId, activeBranchId: branchId });
    // The reader comes back four days later.
    const fourDaysAgo = new Date(Date.now() - 4 * DAY);
    await Study.update({ lastActivityAt: fourDaysAgo }, { where: { id: studyId } });

    expect(await resume(studyId)).toStrictEqual({
      studyId,
      title: expect.any(String),
      lifecycle: 'active',
      lastActivityAt: fourDaysAgo.toISOString(),
      activeQuestion: { nodeId: followUpId, text: 'Whose witness is it?', status: 'open' },
      activeBranch: { id: branchId, rootNodeId: questionNodeId, rootLabel: QUESTION },
      lastPassage: {
        referenceId: john.id,
        label: john.label,
        eventId: visited.eventId,
        occurredAt: anyTime,
      },
      recentConclusion: {
        nodeId: conclusionId,
        text: 'Conscience bears witness',
        status: 'tentative',
      },
      // The active branch holds only its root question so far.
      openQuestions: { items: [{ nodeId: questionNodeId, text: QUESTION }], total: 1 },
      target: { kind: 'node', nodeId: followUpId, referenceId: null, branchId, fallback: false },
      viewState: {
        viewRevision: 2,
        selectedNodeId: followUpId,
        activeBranchId: branchId,
        activeQuestionNodeId: followUpId,
        readerReferenceId: null,
        viewport: null,
        panes: null,
        contextSavedAt: anyTime,
      },
    });
  });

  it('resumes at the last visited passage when the visit came after the saved context', async () => {
    const { studyId, questionNodeId } = await createStudy(alice);
    await saveView(studyId, { selectedNodeId: questionNodeId });
    await visit(studyId, john.id);
    const { target } = await resume(studyId);
    expect(target).toStrictEqual({
      kind: 'passage',
      nodeId: null,
      referenceId: john.id,
      branchId: null,
      fallback: false,
    });
  });

  it('falls back from a deleted node to the surviving branch root, then the starting passage, then the study', async () => {
    const { studyId, questionNodeId, rootNodeId, branchId } = await createStudy(alice);
    const thoughtId = await addNode(studyId, 'thought', 'A passing thought');
    await saveView(studyId, { selectedNodeId: thoughtId, activeBranchId: branchId });

    await softDelete(thoughtId);
    expect((await resume(studyId)).target).toStrictEqual({
      kind: 'branch_root',
      nodeId: questionNodeId,
      referenceId: null,
      branchId,
      fallback: true,
    });

    if (questionNodeId) await softDelete(questionNodeId);
    const withoutRoot = await resume(studyId);
    expect(withoutRoot.target).toStrictEqual({
      kind: 'starting_passage',
      nodeId: rootNodeId,
      referenceId: romans.id,
      branchId: null,
      fallback: true,
    });
    expect(withoutRoot.activeQuestion).toBeNull();

    if (rootNodeId) await softDelete(rootNodeId);
    expect((await resume(studyId)).target).toStrictEqual({
      kind: 'study',
      nodeId: null,
      referenceId: null,
      branchId: null,
      fallback: true,
    });
  });

  it('saves view state on the view revision without moving the study revisions or last activity, and replays a retry', async () => {
    const { studyId, questionNodeId } = await createStudy(alice);
    const before = await Study.findByPk(studyId, { rejectOnEmpty: true });
    const key = randomUUID();
    const body = {
      expectedRevision: 1,
      selectedNodeId: questionNodeId,
      readerReferenceId: romans.id,
      viewport: { x: 10, y: -20, zoom: 1.5 },
      panes: { thread: false, notes: true },
    };
    const first = await send(alice, 'patch', viewStatePath(studyId), body, {
      'Idempotency-Key': key,
    });
    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      viewState: {
        viewRevision: 2,
        selectedNodeId: questionNodeId,
        activeBranchId: null,
        activeQuestionNodeId: questionNodeId,
        readerReferenceId: romans.id,
        viewport: { x: 10, y: -20, zoom: 1.5 },
        panes: { thread: false, notes: true },
        contextSavedAt: anyTime,
      },
      lastEventSequence: anySequence,
    });
    const replay = await send(alice, 'patch', viewStatePath(studyId), body, {
      'Idempotency-Key': key,
    });
    expect({ status: replay.status, body: replay.body as unknown }).toStrictEqual({
      status: 200,
      body: first.body as unknown,
    });
    const after = await Study.findByPk(studyId, { rejectOnEmpty: true });
    expect({
      revision: after.revision,
      contentRevision: after.contentRevision,
      lastActivityAt: after.lastActivityAt,
    }).toStrictEqual({
      revision: before.revision,
      contentRevision: before.contentRevision,
      lastActivityAt: before.lastActivityAt,
    });

    const stale = await send(alice, 'patch', viewStatePath(studyId), {
      expectedRevision: 1,
      panes: { thread: true },
    });
    expect({ status: stale.status, body: stale.body as unknown }).toStrictEqual({
      status: 409,
      body: conflict(2),
    });
    const missing = await send(alice, 'patch', viewStatePath(studyId), { panes: {} });
    expect({ status: missing.status, body: missing.body as unknown }).toStrictEqual({
      status: 428,
      body: REVISION_MISSING,
    });
  });

  it('refuses a deleted or another study’s node in the view state with 404, writing nothing', async () => {
    const mine = await createStudy(alice);
    const other = await createStudy(alice);
    const res = await send(alice, 'patch', viewStatePath(mine.studyId), {
      expectedRevision: 1,
      selectedNodeId: other.questionNodeId,
    });
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NOT_FOUND);
    expect(await StudyViewState.count({ where: { studyId: mine.studyId } })).toBe(0);
  });

  it('GET /v1/studies/:studyId/resume gives another user the same neutral 404 as an absent or malformed study', async () => {
    const { studyId } = await createStudy(alice);
    for (const id of [studyId, randomUUID(), 'not-a-uuid']) {
      const res = await send(bob, 'get', resumePath(id));
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    }
  });

  it("PATCH /v1/studies/:studyId/view-state gives another user the same neutral 404 as an absent or malformed study, and refuses Alice's node in Bob's study, writing nothing", async () => {
    const theirs = await createStudy(alice);
    const own = await createStudy(bob);
    for (const id of [theirs.studyId, randomUUID(), 'not-a-uuid']) {
      const res = await send(bob, 'patch', viewStatePath(id), {
        expectedRevision: 1,
        panes: { thread: true },
      });
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(NOT_FOUND);
    }
    const crossNode = await send(bob, 'patch', viewStatePath(own.studyId), {
      expectedRevision: 1,
      selectedNodeId: theirs.questionNodeId,
    });
    expect(crossNode.status).toBe(404);
    expect(crossNode.body).toStrictEqual(NOT_FOUND);
    expect(await StudyViewState.count({ where: { studyId: [theirs.studyId, own.studyId] } })).toBe(
      0,
    );
  });
});
