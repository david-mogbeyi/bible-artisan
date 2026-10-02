import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  BranchMutationResponse,
  CreateBranchResponse,
  CreateNodeResponse,
  CreateStudyResponse,
  GraphResponse,
  ResolveReferenceResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyBranchMember } from '../src/database/models/study-branch-member.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const anyId: unknown = expect.stringMatching(UUID);
const anyTime: unknown = expect.stringMatching(ISO);
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);

const STUDIES = '/v1/studies';
const nodesPath = (studyId: string): string => `${STUDIES}/${studyId}/nodes`;
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const branchesPath = (studyId: string): string => `/v1/studies/${studyId}/branches`;
const membersPath = (studyId: string, branchId: string): string =>
  `/v1/studies/${studyId}/branches/${branchId}/members`;
const graphPath = (studyId: string): string => `/v1/studies/${studyId}/graph`;

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
const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });
const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
});
const STUDY_TRASHED = envelope({
  code: 'STUDY_TRASHED',
  message: 'This study is in the trash. Restore it to make changes',
});
const ROOT_TYPE_NOT_ALLOWED = envelope({
  code: 'BRANCH_ROOT_TYPE_NOT_ALLOWED',
  message: 'A branch can start only at a question or a passage',
});
const BRANCH_EXISTS = envelope({
  code: 'BRANCH_EXISTS',
  message: 'A branch already starts at this node',
});
const BRANCH_UNCHANGED = envelope({
  code: 'BRANCH_UNCHANGED',
  message: 'Nothing to change in this branch',
});

const CITATION = {
  title: 'Commentary on Romans',
  kind: 'commentary',
  url: 'https://example.org/calvin/romans',
} as const;

/** The SQL a Sequelize query ran (set on the query object; not in its published type). */
const sqlOf = (query: unknown): string => (query as { sql?: string }).sql ?? '';

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** BIB-60: starting branches and changing their members. Real PostgreSQL, whole-body assertions. */
describe('branches (BIB-60)', () => {
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
    method: 'get' | 'post' | 'patch' | 'delete',
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

  const answer = (res: Response): unknown[] => [res.status, res.body];

  async function createStudy(owner: Owner, body: object = { blank: true }) {
    const res = await send(owner, 'post', STUDIES, body);
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  async function revisions(studyId: string) {
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
    return { revision: study.revision, contentRevision: study.contentRevision };
  }

  const studyRevision = async (studyId: string) => (await revisions(studyId)).revision;

  async function createNode(owner: Owner, studyId: string, body: object) {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  const thought = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, { type: 'thought', text: 'Maybe a second witness' });
  const question = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, { type: 'question', text: 'Can conscience be wrong?' });

  const start = async (owner: Owner, studyId: string, rootNodeId: string, key?: string) =>
    send(
      owner,
      'post',
      branchesPath(studyId),
      { expectedRevision: await studyRevision(studyId), rootNodeId },
      key,
    );

  async function started(owner: Owner, studyId: string, rootNodeId: string) {
    const res = await start(owner, studyId, rootNodeId);
    expect(res.status).toBe(201);
    return res.body as CreateBranchResponse;
  }

  const branchRevision = async (branchId: string) =>
    (await StudyBranch.findByPk(branchId, { rejectOnEmpty: true })).revision;

  async function change(
    owner: Owner,
    studyId: string,
    branchId: string,
    lists: { add?: string[]; remove?: string[] },
    key: string = randomUUID(),
  ) {
    return send(
      owner,
      'patch',
      membersPath(studyId, branchId),
      { expectedRevision: await branchRevision(branchId), ...lists },
      key,
    );
  }

  async function changed(
    owner: Owner,
    studyId: string,
    branchId: string,
    lists: { add?: string[]; remove?: string[] },
  ) {
    const res = await change(owner, studyId, branchId, lists);
    expect(res.status).toBe(200);
    return res.body as BranchMutationResponse;
  }

  const graph = async (owner: Owner, studyId: string) => {
    const res = await send(owner, 'get', graphPath(studyId));
    expect(res.status).toBe(200);
    return res.body as GraphResponse;
  };

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({ eventType: e.eventType, payload: e.payloadJson }));
  }

  /** Every row a branch request could touch, to prove a request wrote nothing. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: ['id', 'revision', 'contentRevision', 'lastEventSequence', 'lastActivityAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      nodes: await StudyNode.findAll({
        where,
        attributes: ['id', 'revision', 'updatedAt', 'deletedAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      branches: await StudyBranch.findAll({ where, order: [['id', 'ASC']], raw: true }),
      members: await StudyBranchMember.findAll({
        where,
        order: [
          ['branchId', 'ASC'],
          ['nodeId', 'ASC'],
        ],
        raw: true,
      }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  async function lifecycle(owner: Owner, studyId: string, to: 'archive' | 'trash') {
    const expectedRevision = await studyRevision(studyId);
    const res =
      to === 'archive'
        ? await send(owner, 'post', `${STUDIES}/${studyId}/archive`, { expectedRevision })
        : await send(owner, 'delete', `${STUDIES}/${studyId}`, { expectedRevision });
    expect(res.status).toBe(200);
  }

  /** Runs `fn` while every statement the app issues is recorded (its SQL, after it ran). */
  async function recordingStatements<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; sql: string[] }> {
    const sql: string[] = [];
    const name = `record-${randomUUID()}`;
    db.addHook('afterQuery', name, (_options, query) => {
      sql.push(sqlOf(query));
    });
    try {
      return { result: await fn(), sql };
    } finally {
      db.removeHook('afterQuery', name);
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const resolved = await send(alice, 'post', '/v1/bible/resolve', {
      input: 'Romans 9:1',
      editionId: edition.id,
    });
    const body = resolved.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    romans = body.reference;
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its nodes, branches and members.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('POST /branches', () => {
    it('starts a branch at a Question node: 201 with the branch, one branch_created event, the study revision moves and the content revision does not; it is in GET /graph after reload', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const second = await question(alice, studyId);
      const before = await revisions(studyId);
      const eventsBefore = await events(studyId);

      const res = await start(alice, studyId, second.toUpperCase());
      expect(answer(res)).toStrictEqual([
        201,
        {
          id: anyId,
          rootNodeId: second,
          memberNodeIds: [],
          revision: 1,
          createdAt: anyTime,
          studyId,
          studyRevision: before.revision + 1,
          lastEventSequence: anySequence,
        },
      ]);
      const branch = res.body as CreateBranchResponse;
      expect(await revisions(studyId)).toStrictEqual({
        revision: before.revision + 1,
        contentRevision: before.contentRevision,
      });
      expect(await events(studyId)).toStrictEqual([
        ...eventsBefore,
        { eventType: 'branch_created', payload: { branchId: branch.id, rootNodeId: second } },
      ]);
      expect((await graph(alice, studyId)).branches).toStrictEqual([
        {
          id: created.branchId,
          rootNodeId: created.questionNodeId,
          memberNodeIds: [],
          revision: 1,
          createdAt: anyTime,
        },
        {
          id: branch.id,
          rootNodeId: second,
          memberNodeIds: [],
          revision: 1,
          createdAt: branch.createdAt,
        },
      ]);
    });

    it('starts a branch at a Scripture node, including a deliberate duplicate', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const passage = await createNode(alice, studyId, {
        type: 'scripture',
        referenceId: romans.id,
      });
      const duplicate = await createNode(alice, studyId, {
        type: 'scripture',
        referenceId: romans.id,
        duplicatePolicy: 'explicit_duplicate',
      });
      for (const rootNodeId of [passage, duplicate]) {
        const res = await start(alice, studyId, rootNodeId);
        expect([res.status, (res.body as CreateBranchResponse).rootNodeId]).toStrictEqual([
          201,
          rootNodeId,
        ]);
      }
      expect((await graph(alice, studyId)).branches.map((b) => b.rootNodeId)).toStrictEqual([
        passage,
        duplicate,
      ]);
    });

    it('refuses an Observation, Thought, Conclusion or Source root with 422 and a node that already roots a branch with 422 BRANCH_EXISTS, writing nothing', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const others = [
        await createNode(alice, studyId, {
          type: 'observation',
          text: 'Paul appeals to conscience',
          observationKind: 'textual_observation',
        }),
        await thought(alice, studyId),
        await createNode(alice, studyId, { type: 'conclusion', text: 'An inner witness' }),
        await createNode(alice, studyId, { type: 'source', source: CITATION }),
      ];
      const second = await question(alice, studyId);
      await started(alice, studyId, second);
      const before = await ownerRows(alice);
      const answers = [];
      for (const rootNodeId of others)
        answers.push(answer(await start(alice, studyId, rootNodeId)));
      // The initial branch's root (BIB-19) and a manually started root.
      answers.push(answer(await start(alice, studyId, created.questionNodeId as string)));
      answers.push(answer(await start(alice, studyId, second)));
      expect(answers).toStrictEqual([
        ...others.map(() => [422, ROOT_TYPE_NOT_ALLOWED]),
        [422, BRANCH_EXISTS],
        [422, BRANCH_EXISTS],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('a stale study revision is 409 with currentRevision, a missing one 428, and an absent, deleted, malformed or other-study root 404, all writing nothing', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const root = await question(alice, studyId);
      const gone = await question(alice, studyId);
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: gone } });
      const otherStudy = (await createStudy(alice)).studyId;
      const elsewhere = await question(alice, otherStudy);
      const current = await studyRevision(studyId);
      const before = await ownerRows(alice);
      const post = (body: object) => send(alice, 'post', branchesPath(studyId), body);
      expect([
        answer(await post({ expectedRevision: current - 1, rootNodeId: root })),
        answer(await post({ rootNodeId: root })),
        answer(await post({ expectedRevision: current, rootNodeId: randomUUID() })),
        answer(await post({ expectedRevision: current, rootNodeId: gone })),
        answer(await post({ expectedRevision: current, rootNodeId: 'not-a-node' })),
        answer(await post({ expectedRevision: current, rootNodeId: elsewhere })),
        answer(await post({ expectedRevision: current, rootNodeId: root, label: 'x' })),
      ]).toStrictEqual([
        [409, conflict(current)],
        [428, REVISION_MISSING],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [400, invalid({ _: [expect.any(String) as string] })],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('replays the same Idempotency-Key and body without a second branch or event; the same key with another body is 422', async () => {
      const studyId = (await createStudy(alice, { question: 'What is conscience?' })).studyId;
      const [a, b] = [await question(alice, studyId), await question(alice, studyId)];
      const key = randomUUID();
      const expectedRevision = await studyRevision(studyId);
      const body = { expectedRevision, rootNodeId: a };
      const first = await send(alice, 'post', branchesPath(studyId), body, key);
      expect(first.status).toBe(201);
      const eventCount = (await events(studyId)).length;
      const replay = await send(alice, 'post', branchesPath(studyId), body, key);
      const reused = await send(
        alice,
        'post',
        branchesPath(studyId),
        { expectedRevision, rootNodeId: b },
        key,
      );
      expect({
        replay: [replay.status, replay.headers['idempotent-replayed'], replay.body],
        reused: answer(reused),
        branches: await StudyBranch.count({ where: { studyId } }),
        events: (await events(studyId)).length,
      }).toStrictEqual({
        replay: [201, 'true', first.body],
        reused: [422, KEY_REUSED],
        branches: 2,
        events: eventCount,
      });
    });

    it("POST /v1/studies/:studyId/branches gives another user the same neutral 404 as an absent or malformed study, and never roots a branch at another user's node, writing nothing", async () => {
      const studyId = (await createStudy(alice)).studyId;
      const root = await question(alice, studyId);
      const bobsStudy = (await createStudy(bob)).studyId;
      const before = { alice: await ownerRows(alice), bob: await ownerRows(bob) };
      const body = { expectedRevision: await studyRevision(studyId), rootNodeId: root };
      const answers = [
        await send(bob, 'post', branchesPath(studyId), body, randomUUID()),
        await send(bob, 'post', branchesPath(randomUUID()), body, randomUUID()),
        await send(bob, 'post', branchesPath('not-a-study'), body, randomUUID()),
        // Alice's node under Bob's own study.
        await send(
          bob,
          'post',
          branchesPath(bobsStudy),
          { expectedRevision: await studyRevision(bobsStudy), rootNodeId: root },
          randomUUID(),
        ),
        await send(null, 'post', branchesPath(studyId), body),
      ].map(answer);
      expect({
        answers,
        rows: { alice: await ownerRows(alice), bob: await ownerRows(bob) },
      }).toStrictEqual({
        answers: [
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [401, UNAUTHENTICATED],
        ],
        rows: before,
      });
    });
  });

  describe('PATCH /branches/:branchId/members', () => {
    it('adds two nodes: 200 with the members, one internal branch_members_changed event with the net change, the branch revision moves; the study revision and content revision do not', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, b] = [await thought(alice, studyId), await thought(alice, studyId)].sort(byId);
      const before = await revisions(studyId);
      const eventsBefore = await events(studyId);
      // A node create from another tab holds the study revision from before the change.
      const held = before.revision;

      const res = await change(alice, studyId, branchId, { add: [b as string, a as string] });
      expect(answer(res)).toStrictEqual([
        200,
        {
          id: branchId,
          rootNodeId: created.questionNodeId,
          memberNodeIds: [a, b],
          revision: 2,
          createdAt: anyTime,
          lastEventSequence: anySequence,
        },
      ]);
      expect(await revisions(studyId)).toStrictEqual(before);
      expect(await events(studyId)).toStrictEqual([
        ...eventsBefore,
        {
          eventType: 'branch_members_changed',
          payload: { branchId, addedNodeIds: [b, a], removedNodeIds: [] },
        },
      ]);
      const create = await send(alice, 'post', nodesPath(studyId), {
        expectedRevision: held,
        type: 'thought',
        text: 'Created in another tab',
      });
      expect(create.status).toBe(201);
      expect((await graph(alice, studyId)).branches[0]?.memberNodeIds).toStrictEqual([a, b]);
    });

    it('removes a member (its row goes, the event lists it), adds and removes in one request, and lists members oldest membership first', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, b] = [await thought(alice, studyId), await thought(alice, studyId)].sort(byId);
      const c = await thought(alice, studyId);
      await changed(alice, studyId, branchId, { add: [c] });
      const both = await changed(alice, studyId, branchId, {
        add: [b as string, a as string],
      });
      // `c` joined first; `a` and `b` joined together, so they follow by node id.
      expect(both.memberNodeIds).toStrictEqual([c, a, b]);
      const removed = await changed(alice, studyId, branchId, { add: [], remove: [a as string] });
      expect([removed.memberNodeIds, removed.revision]).toStrictEqual([[c, b], 4]);
      expect(await StudyBranchMember.count({ where: { branchId, nodeId: a } })).toBe(0);
      const swapped = await changed(alice, studyId, branchId, {
        add: [a as string],
        remove: [c],
      });
      expect(swapped.memberNodeIds).toStrictEqual([b, a]);
      expect((await events(studyId)).slice(-2)).toStrictEqual([
        {
          eventType: 'branch_members_changed',
          payload: { branchId, addedNodeIds: [], removedNodeIds: [a] },
        },
        {
          eventType: 'branch_members_changed',
          payload: { branchId, addedNodeIds: [a], removedNodeIds: [c] },
        },
      ]);
    });

    it('counts only the net change: re-adding a member or the root and removing a non-member are no-ops, and nothing at all to change is 422 BRANCH_UNCHANGED, writing nothing', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const root = created.questionNodeId as string;
      const [a, b, c] = [
        await thought(alice, studyId),
        await thought(alice, studyId),
        await thought(alice, studyId),
      ];
      await changed(alice, studyId, branchId, { add: [a] });
      const mixed = await changed(alice, studyId, branchId, {
        add: [a, root, b],
        remove: [c],
      });
      expect((await events(studyId)).at(-1)).toStrictEqual({
        eventType: 'branch_members_changed',
        payload: { branchId, addedNodeIds: [b], removedNodeIds: [] },
      });
      expect(mixed.memberNodeIds).toStrictEqual([a, b]);

      const before = await ownerRows(alice);
      expect([
        answer(await change(alice, studyId, branchId, { add: [a, root] })),
        answer(await change(alice, studyId, branchId, { remove: [root, c] })),
      ]).toStrictEqual([
        [422, BRANCH_UNCHANGED],
        [422, BRANCH_UNCHANGED],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('refuses an id in both lists, more than 100 ids, a duplicate, an empty change and unknown keys with 400, writing nothing', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const a = await thought(alice, studyId);
      const many = Array.from({ length: 101 }, () => randomUUID());
      const before = await ownerRows(alice);
      const patch = (body: object) =>
        send(alice, 'patch', membersPath(studyId, branchId), { expectedRevision: 1, ...body });
      expect([
        answer(await patch({ add: [a], remove: [a] })),
        answer(await patch({ add: many })),
        answer(await patch({ remove: [a, a.toUpperCase()] })),
        answer(await patch({})),
        answer(await patch({ add: [a], label: 'x' })),
      ]).toStrictEqual([
        [400, invalid({ 'remove.0': ['A node cannot be added and removed at once'] })],
        [400, invalid({ add: [expect.any(String) as string] })],
        [400, invalid({ 'remove.1': ['Each node can appear only once'] })],
        [400, invalid({ add: ['Send at least one node to add or remove'] })],
        [400, invalid({ _: [expect.any(String) as string] })],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it("a node of another study, another user's node, a deleted node, an absent or malformed id, and another study's branch are 404 with nothing written", async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const a = await thought(alice, studyId);
      const gone = await thought(alice, studyId);
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: gone } });
      const other = await createStudy(alice, { question: 'Elsewhere?' });
      const elsewhere = await thought(alice, other.studyId);
      const bobsNode = await thought(bob, (await createStudy(bob)).studyId);
      const before = await ownerRows(alice);
      const answers = [];
      for (const id of [elsewhere, bobsNode, gone, randomUUID(), 'not-a-node']) {
        // Alongside a valid node: one bad id refuses the whole request.
        answers.push(answer(await change(alice, studyId, branchId, { add: [a, id] })));
      }
      answers.push(answer(await change(alice, studyId, branchId, { remove: [elsewhere] })));
      // Alice's branch through her other study's path, and an absent branch.
      answers.push(answer(await change(alice, other.studyId, branchId, { add: [elsewhere] })));
      answers.push(
        answer(
          await send(alice, 'patch', membersPath(studyId, randomUUID()), {
            expectedRevision: 1,
            add: [a],
          }),
        ),
      );
      expect(answers).toStrictEqual(Array(8).fill([404, NOT_FOUND]));
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('a stale branch revision is 409 with the branch revision as currentRevision, a missing one 428, and neither writes', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, b] = [await thought(alice, studyId), await thought(alice, studyId)];
      await changed(alice, studyId, branchId, { add: [a] });
      const before = await ownerRows(alice);
      const patch = (body: object) => send(alice, 'patch', membersPath(studyId, branchId), body);
      expect([
        answer(await patch({ expectedRevision: 1, add: [b] })),
        answer(await patch({ add: [b] })),
      ]).toStrictEqual([
        [409, conflict(2)],
        [428, REVISION_MISSING],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('lets a node belong to several branches: it is listed in each', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const second = await started(alice, studyId, await question(alice, studyId));
      const shared = await thought(alice, studyId);
      await changed(alice, studyId, created.branchId as string, { add: [shared] });
      await changed(alice, studyId, second.id, { add: [shared] });
      // A branch root can be a member of another branch too.
      await changed(alice, studyId, created.branchId as string, { add: [second.rootNodeId] });
      expect(
        (await graph(alice, studyId)).branches.map((b) => [b.id, b.memberNodeIds]),
      ).toStrictEqual([
        [created.branchId, [shared, second.rootNodeId]],
        [second.id, [shared]],
      ]);
    });

    it('replays the same Idempotency-Key and body without a second change or event; the same key with another body is 422', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, b] = [await thought(alice, studyId), await thought(alice, studyId)];
      const key = randomUUID();
      const first = await change(alice, studyId, branchId, { add: [a] }, key);
      expect(first.status).toBe(200);
      const eventCount = (await events(studyId)).length;
      const body = { expectedRevision: 1, add: [a] };
      const replay = await send(alice, 'patch', membersPath(studyId, branchId), body, key);
      const reused = await send(
        alice,
        'patch',
        membersPath(studyId, branchId),
        { expectedRevision: 1, add: [b] },
        key,
      );
      expect({
        replay: [replay.status, replay.headers['idempotent-replayed'], replay.body],
        reused: answer(reused),
        revision: await branchRevision(branchId),
        events: (await events(studyId)).length,
      }).toStrictEqual({
        replay: [200, 'true', first.body],
        reused: [422, KEY_REUSED],
        revision: 2,
        events: eventCount,
      });
    });

    it("PATCH /v1/studies/:studyId/branches/:branchId/members gives another user the same neutral 404 as an absent or malformed id, and never moves another user's node into a branch, writing nothing", async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const a = await thought(alice, studyId);
      const bobs = await createStudy(bob, { question: "Bob's question" });
      const bobsNode = await thought(bob, bobs.studyId);
      const before = { alice: await ownerRows(alice), bob: await ownerRows(bob) };
      const body = { expectedRevision: 1, add: [a] };
      const answers = [
        await send(bob, 'patch', membersPath(studyId, branchId), body, randomUUID()),
        await send(bob, 'patch', membersPath(studyId, randomUUID()), body, randomUUID()),
        await send(bob, 'patch', membersPath(randomUUID(), branchId), body, randomUUID()),
        await send(bob, 'patch', membersPath('not-a-study', 'not-a-branch'), body, randomUUID()),
        // Alice's branch under Bob's own study, and Alice's node into Bob's own branch.
        await send(
          bob,
          'patch',
          membersPath(bobs.studyId, branchId),
          { expectedRevision: 1, add: [bobsNode] },
          randomUUID(),
        ),
        await send(
          bob,
          'patch',
          membersPath(bobs.studyId, bobs.branchId as string),
          body,
          randomUUID(),
        ),
        await send(null, 'patch', membersPath(studyId, branchId), body),
      ].map(answer);
      expect({
        answers,
        rows: { alice: await ownerRows(alice), bob: await ownerRows(bob) },
      }).toStrictEqual({
        answers: [
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [401, UNAUTHENTICATED],
        ],
        rows: before,
      });
    });
  });

  it('refuses starting a branch and changing members on an archived or trashed study with 422, writing nothing, while branches stay readable', async () => {
    for (const [to, refusal] of [
      ['archive', STUDY_ARCHIVED],
      ['trash', STUDY_TRASHED],
    ] as const) {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, root] = [await thought(alice, studyId), await question(alice, studyId)];
      await changed(alice, studyId, branchId, { add: [a] });
      await lifecycle(alice, studyId, to);
      const before = await ownerRows(alice);
      expect([
        answer(await start(alice, studyId, root)),
        answer(await change(alice, studyId, branchId, { remove: [a] })),
      ]).toStrictEqual([
        [422, refusal],
        [422, refusal],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
      expect((await graph(alice, studyId)).branches.map((b) => b.memberNodeIds)).toStrictEqual([
        [a],
      ]);
    }
  });

  describe('GET /graph branches', () => {
    it('returns each branch with its revision and live members only (a member whose node was deleted is left out), never the root', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const branchId = created.branchId as string;
      const [a, b] = [await thought(alice, studyId), await thought(alice, studyId)].sort(byId);
      await changed(alice, studyId, branchId, { add: [a as string, b as string] });
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: a } });
      expect((await graph(alice, studyId)).branches).toStrictEqual([
        {
          id: branchId,
          rootNodeId: created.questionNodeId,
          memberNodeIds: [b],
          revision: 2,
          createdAt: anyTime,
        },
      ]);
      // The row stays (BIB-31's restore), only reads skip it.
      expect(await StudyBranchMember.count({ where: { branchId } })).toBe(2);
    });

    it('reads every membership with the same fixed number of statements for one branch as for thirty', async () => {
      const one = await createStudy(alice, { question: 'One branch' });
      await changed(alice, one.studyId, one.branchId as string, {
        add: [await thought(alice, one.studyId)],
      });
      const few = await recordingStatements(() => graph(alice, one.studyId));

      const many = await createStudy(alice, { question: 'Thirty branches' });
      const scope = [many.studyId, alice.user.id];
      // 29 more Question roots and 60 thoughts, each thought a member of every branch.
      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, title, question_status)
         SELECT $1, $2, 'question', 'user', 'Seed question ' || g, 'open' FROM generate_series(1, 29) g`,
        { bind: scope },
      );
      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         SELECT $1, $2, 'thought', 'user', 'Seed thought ' || g FROM generate_series(1, 60) g`,
        { bind: scope },
      );
      await db.query(
        `INSERT INTO study_branch (study_id, owner_id, root_node_id)
         SELECT $1, $2, id FROM study_node
          WHERE study_id = $1 AND type = 'question' AND id <> $3`,
        { bind: [...scope, many.questionNodeId] },
      );
      await db.query(
        `INSERT INTO study_branch_member (study_id, owner_id, branch_id, node_id)
         SELECT $1, $2, b.id, n.id FROM study_branch b, study_node n
          WHERE b.study_id = $1 AND n.study_id = $1 AND n.type = 'thought'`,
        { bind: scope },
      );
      const lots = await recordingStatements(() => graph(alice, many.studyId));
      expect({
        branches: lots.result.branches.length,
        members: lots.result.branches.every((b) => b.memberNodeIds.length === 60),
        statements: lots.sql.length,
      }).toStrictEqual({ branches: 30, members: true, statements: few.sql.length });
    });
  });
});
