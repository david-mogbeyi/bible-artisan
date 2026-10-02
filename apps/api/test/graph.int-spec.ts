import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateEdgeResponse,
  CreateNodeResponse,
  CreateStudyResponse,
  GraphResponse,
  NodeListResponse,
  ResolveReferenceResponse,
  SavePositionsResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNodePosition } from '../src/database/models/study-node-position.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { StudyViewState } from '../src/database/models/study-view-state.model';
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
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);

const STUDIES = '/v1/studies';
const nodesPath = (studyId: string): string => `${STUDIES}/${studyId}/nodes`;
const edgesPath = (studyId: string): string => `${STUDIES}/${studyId}/edges`;
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const graphPath = (studyId: string): string => `/v1/studies/${studyId}/graph`;
const positionsPath = (studyId: string): string => `/v1/studies/${studyId}/positions`;

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
const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
});
const STUDY_TRASHED = envelope({
  code: 'STUDY_TRASHED',
  message: 'This study is in the trash. Restore it to make changes',
});

/** The SQL a Sequelize query ran (set on the query object; not in its published type). */
const sqlOf = (query: unknown): string => (query as { sql?: string }).sql ?? '';

/** BIB-28: the graph snapshot and persistent positions. Real PostgreSQL, whole-body assertions. */
describe('graph snapshot and positions (BIB-28)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  let editionId: string;
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

  async function createStudy(owner: Owner, body: object = { blank: true }) {
    const res = await send(owner, 'post', STUDIES, body);
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  async function createNode(owner: Owner, studyId: string, body: object) {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body as CreateNodeResponse;
  }

  const thought = async (owner: Owner, studyId: string) =>
    (await createNode(owner, studyId, { type: 'thought', text: 'Maybe a second witness' })).id;

  async function connect(owner: Owner, studyId: string, body: object) {
    const res = await send(owner, 'post', edgesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body as CreateEdgeResponse;
  }

  const graph = async (owner: Owner, studyId: string) => {
    const res = await send(owner, 'get', graphPath(studyId));
    expect(res.status).toBe(200);
    return res.body as GraphResponse;
  };

  const save = (
    owner: Owner,
    studyId: string,
    expectedRevision: number | undefined,
    positions: { nodeId: string; x: number; y: number }[],
    key: string = randomUUID(),
  ) =>
    send(
      owner,
      'patch',
      positionsPath(studyId),
      expectedRevision === undefined ? { positions } : { expectedRevision, positions },
      key,
    );

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({ eventType: e.eventType, payload: e.payloadJson }));
  }

  /** Every row a position save could touch, to prove a request wrote nothing (or only that). */
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
      edges: await StudyEdge.findAll({
        where,
        attributes: ['id', 'type', 'revision', 'updatedAt', 'deletedAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      positions: await StudyNodePosition.findAll({
        where,
        order: [
          ['studyId', 'ASC'],
          ['nodeId', 'ASC'],
        ],
        raw: true,
      }),
      viewStates: await StudyViewState.findAll({ where, order: [['id', 'ASC']], raw: true }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  async function lifecycle(owner: Owner, studyId: string, change: 'archive' | 'trash') {
    const expectedRevision = await studyRevision(studyId);
    const res =
      change === 'archive'
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
    editionId = edition.id;
    const resolved = await send(alice, 'post', '/v1/bible/resolve', {
      input: 'Romans 9:1',
      editionId,
    });
    const body = resolved.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    romans = body.reference;
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its nodes, edges, positions and
    // view state.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('GET /graph', () => {
    it('returns one snapshot: the GET /nodes items, live edges without notes, branches, positions of live nodes and both revisions', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const studyId = created.studyId;
      const question = created.questionNodeId as string;
      const scripture = (
        await createNode(alice, studyId, { type: 'scripture', referenceId: romans.id })
      ).id;
      const duplicate = (
        await createNode(alice, studyId, {
          type: 'scripture',
          referenceId: romans.id,
          duplicatePolicy: 'explicit_duplicate',
        })
      ).id;
      const observation = (
        await createNode(alice, studyId, {
          type: 'observation',
          text: 'Paul appeals to conscience',
          observationKind: 'textual_observation',
        })
      ).id;
      const gone = await thought(alice, studyId);
      const supports = await connect(alice, studyId, {
        sourceNodeId: observation,
        targetNodeId: question,
        type: 'supports',
        note: 'A private note the graph never returns',
      });
      const parallels = await connect(alice, studyId, {
        sourceNodeId: scripture,
        targetNodeId: duplicate,
        type: 'parallels',
      });
      const removed = await connect(alice, studyId, {
        sourceNodeId: duplicate,
        targetNodeId: question,
        type: 'raises_question',
      });
      const toGone = await connect(alice, studyId, {
        sourceNodeId: gone,
        targetNodeId: question,
        type: 'explains',
      });
      expect(
        (
          await send(alice, 'delete', `${edgesPath(studyId)}/${removed.id}`, {
            expectedRevision: 1,
          })
        ).status,
      ).toBe(200);

      // Before any position save the view revision is 1 and there are no positions.
      const first = await graph(alice, studyId);
      expect(first.viewRevision).toBe(1);
      expect(first.positions).toStrictEqual([]);

      const saved = await save(alice, studyId, 1, [
        { nodeId: question, x: 120.5, y: -40 },
        { nodeId: observation, x: -300, y: 260.25 },
        { nodeId: gone, x: 9, y: 9 },
      ]);
      expect(saved.status).toBe(200);
      // A node deleted after its position was saved: its row stays, but it is never returned,
      // and neither is its edge (node delete arrives with BIB-31; soft-deleted directly here).
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: gone } });

      const nodes = (await send(alice, 'get', nodesPath(studyId))).body as NodeListResponse;
      expect(nodes.items.map((node) => node.id)).toStrictEqual([
        question,
        scripture,
        duplicate,
        observation,
      ]);
      const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const res = await send(alice, 'get', graphPath(studyId));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const byId = (a: { nodeId: string }, b: { nodeId: string }) =>
        a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
      expect(res.body).toStrictEqual({
        studyId,
        contentRevision: study.contentRevision,
        viewRevision: 2,
        nodes: nodes.items,
        edges: [
          {
            id: supports.id,
            sourceNodeId: observation,
            targetNodeId: question,
            type: 'supports',
            origin: 'user',
          },
          {
            id: parallels.id,
            sourceNodeId: parallels.sourceNodeId,
            targetNodeId: parallels.targetNodeId,
            type: 'parallels',
            origin: 'user',
          },
        ],
        branches: [
          {
            id: created.branchId,
            rootNodeId: question,
            createdAt: expect.stringMatching(ISO) as string,
          },
        ],
        positions: [
          { nodeId: question, x: 120.5, y: -40 },
          { nodeId: observation, x: -300, y: 260.25 },
        ].sort(byId),
      });
      expect(toGone.id).toMatch(UUID);
      expect(await StudyNodePosition.count({ where: { studyId, nodeId: gone } })).toBe(1);
    });

    it('reads the snapshot in one transaction: a position save committed in the middle of the read is wholly absent from it', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const pausedAfterStudy = new Promise<void>((resolve) => (paused = resolve));
      let armed = true;
      const name = `pause-${randomUUID()}`;
      // Pause the GET right after it read the study row (its snapshot is taken), before it reads
      // the nodes, positions and view state.
      db.addHook('afterQuery', name, async (_options, query) => {
        if (armed && /FROM "study" AS "Study"/.test(sqlOf(query))) {
          armed = false;
          paused();
          await released;
        }
      });
      try {
        const reading = send(alice, 'get', graphPath(studyId));
        await pausedAfterStudy;
        const saved = await save(alice, studyId, 1, [{ nodeId: a, x: 50, y: 60 }]);
        expect(saved.status).toBe(200);
        release();
        const res = await reading;
        expect(res.status).toBe(200);
        const body = res.body as GraphResponse;
        // Both the view revision and the positions are from before the save, never a mix.
        expect({ viewRevision: body.viewRevision, positions: body.positions }).toStrictEqual({
          viewRevision: 1,
          positions: [],
        });
      } finally {
        db.removeHook('afterQuery', name);
        release();
      }
      const after = await graph(alice, studyId);
      expect({ viewRevision: after.viewRevision, positions: after.positions }).toStrictEqual({
        viewRevision: 2,
        positions: [{ nodeId: a, x: 50, y: 60 }],
      });
    });

    it('stays readable for archived and trashed studies', async () => {
      for (const change of ['archive', 'trash'] as const) {
        const studyId = (await createStudy(alice)).studyId;
        const a = await thought(alice, studyId);
        expect((await save(alice, studyId, 1, [{ nodeId: a, x: 1, y: 2 }])).status).toBe(200);
        await lifecycle(alice, studyId, change);
        const body = await graph(alice, studyId);
        expect({ viewRevision: body.viewRevision, positions: body.positions }).toStrictEqual({
          viewRevision: 2,
          positions: [{ nodeId: a, x: 1, y: 2 }],
        });
      }
    });

    it('GET /v1/studies/:studyId/graph gives another user the same neutral 404 as an absent, malformed or past-window study', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      expect((await save(alice, studyId, 1, [{ nodeId: a, x: 1, y: 2 }])).status).toBe(200);
      const expired = (await createStudy(alice)).studyId;
      await db.query(
        `UPDATE study SET lifecycle = 'trashed', deleted_at = now() - interval '31 days' WHERE id = $1`,
        { bind: [expired], type: QueryTypes.UPDATE },
      );
      const answers = [
        await send(bob, 'get', graphPath(studyId)),
        await send(bob, 'get', graphPath(randomUUID())),
        await send(bob, 'get', graphPath('not-a-study')),
        await send(alice, 'get', graphPath(expired)),
      ].map((res) => ({ status: res.status, body: res.body as unknown }));
      expect(answers).toStrictEqual(Array(4).fill({ status: 404, body: NOT_FOUND }));
      const anonymous = await send(null, 'get', graphPath(studyId));
      expect({ status: anonymous.status, body: anonymous.body as unknown }).toStrictEqual({
        status: 401,
        body: UNAUTHENTICATED,
      });
    });
  });

  describe('PATCH /positions', () => {
    it('saves positions as presentation: the view revision moves; the study revision, content revision, nodes and edges do not; one internal node_position_saved event', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      await connect(alice, studyId, { sourceNodeId: a, targetNodeId: b, type: 'supports' });
      const before = await ownerRows(alice);
      const eventsBefore = await events(studyId);

      const res = await save(alice, studyId, 1, [
        { nodeId: a, x: 10, y: 20 },
        { nodeId: b, x: -30.75, y: 40 },
      ]);
      expect({ status: res.status, body: res.body as unknown }).toStrictEqual({
        status: 200,
        body: { viewRevision: 2, lastEventSequence: anySequence },
      });
      const after = await ownerRows(alice);
      const study = (rows: typeof before) => rows.studies.find((row) => row.id === studyId);
      expect({
        revision: study(after)?.revision,
        contentRevision: study(after)?.contentRevision,
      }).toStrictEqual({
        revision: study(before)?.revision,
        contentRevision: study(before)?.contentRevision,
      });
      expect(after.nodes).toStrictEqual(before.nodes);
      expect(after.edges).toStrictEqual(before.edges);
      expect(await events(studyId)).toStrictEqual([
        ...eventsBefore,
        { eventType: 'node_position_saved', payload: { nodeCount: 2, viewRevision: 2 } },
      ]);
      expect((res.body as SavePositionsResponse).lastEventSequence).toBe(
        String(eventsBefore.length + 1),
      );
      const body = await graph(alice, studyId);
      expect({ viewRevision: body.viewRevision, positions: body.positions }).toStrictEqual({
        viewRevision: 2,
        positions: [
          { nodeId: a, x: 10, y: 20 },
          { nodeId: b, x: -30.75, y: 40 },
        ].sort((p, q) => (p.nodeId < q.nodeId ? -1 : 1)),
      });
    });

    it('changes only the sent nodes: every other stored position stays byte-for-byte as it was', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      expect(
        (
          await save(alice, studyId, 1, [
            { nodeId: a, x: 1.1, y: 2.2 },
            { nodeId: b, x: 3.3, y: 4.4 },
          ])
        ).status,
      ).toBe(200);
      const untouched = await StudyNodePosition.findOne({
        where: { studyId, nodeId: b },
        raw: true,
        rejectOnEmpty: true,
      });
      expect((await save(alice, studyId, 2, [{ nodeId: a, x: 5, y: 6 }])).status).toBe(200);
      expect(
        await StudyNodePosition.findOne({ where: { studyId, nodeId: b }, raw: true }),
      ).toStrictEqual(untouched);
      expect(
        await StudyNodePosition.findOne({
          where: { studyId, nodeId: a },
          attributes: ['x', 'y'],
          raw: true,
        }),
      ).toStrictEqual({ x: 5, y: 6 });
    });

    it('a stale view revision is 409 with the view revision as currentRevision, a missing one 428, and neither writes', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      // No view state yet: anything but 1 is stale, and the lazily created row rolls back.
      const before = await ownerRows(alice);
      const early = await save(alice, studyId, 3, [{ nodeId: a, x: 1, y: 1 }]);
      expect({ status: early.status, body: early.body as unknown }).toStrictEqual({
        status: 409,
        body: conflict(1),
      });
      expect(await ownerRows(alice)).toStrictEqual(before);

      expect((await save(alice, studyId, 1, [{ nodeId: a, x: 1, y: 1 }])).status).toBe(200);
      const saved = await ownerRows(alice);
      const stale = await save(alice, studyId, 1, [{ nodeId: a, x: 2, y: 2 }]);
      const missing = await save(alice, studyId, undefined, [{ nodeId: a, x: 2, y: 2 }]);
      expect(
        [stale, missing].map((res) => ({ status: res.status, body: res.body as unknown })),
      ).toStrictEqual([
        { status: 409, body: conflict(2) },
        { status: 428, body: REVISION_MISSING },
      ]);
      expect(await ownerRows(alice)).toStrictEqual(saved);
    });

    it('refuses more than 100 positions, an empty list, a node twice, out-of-range coordinates and unknown keys with 400, writing nothing', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const before = await ownerRows(alice);
      const many = Array.from({ length: 101 }, () => ({ nodeId: randomUUID(), x: 0, y: 0 }));
      const answers = [
        await save(alice, studyId, 1, many),
        await save(alice, studyId, 1, []),
        await save(alice, studyId, 1, [
          { nodeId: a, x: 1, y: 1 },
          { nodeId: a.toUpperCase(), x: 2, y: 2 },
        ]),
        await save(alice, studyId, 1, [{ nodeId: a, x: 1e7, y: 0 }]),
        await send(alice, 'patch', positionsPath(studyId), {
          expectedRevision: 1,
          positions: [{ nodeId: a, x: 1, y: 1, dragging: false }],
        }),
      ];
      expect(answers.map((res) => res.status)).toStrictEqual([400, 400, 400, 400, 400]);
      expect(answers[2]?.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { 'positions.1.nodeId': ['Each node can appear only once'] },
        }),
      );
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it("a node of another study, another user's node, a deleted node or an absent id is 404 with nothing written", async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const otherStudy = (await createStudy(alice)).studyId;
      const elsewhere = await thought(alice, otherStudy);
      const bobStudy = (await createStudy(bob)).studyId;
      const bobs = await thought(bob, bobStudy);
      const deleted = await thought(alice, studyId);
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: deleted } });
      const before = { alice: await ownerRows(alice), bob: await ownerRows(bob) };
      const answers = [];
      for (const nodeId of [elsewhere, bobs, deleted, randomUUID()]) {
        const res = await save(alice, studyId, 1, [
          { nodeId: a, x: 1, y: 1 },
          { nodeId, x: 2, y: 2 },
        ]);
        answers.push({ status: res.status, body: res.body as unknown });
      }
      expect(answers).toStrictEqual(Array(4).fill({ status: 404, body: NOT_FOUND }));
      expect({ alice: await ownerRows(alice), bob: await ownerRows(bob) }).toStrictEqual(before);
    });

    it('replays the same Idempotency-Key and body without a second write or event; the same key with another body is 422', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const key = randomUUID();
      const first = await save(alice, studyId, 1, [{ nodeId: a, x: 7, y: 8 }], key);
      expect(first.status).toBe(200);
      const after = await ownerRows(alice);
      const replay = await save(alice, studyId, 1, [{ nodeId: a, x: 7, y: 8 }], key);
      expect({
        status: replay.status,
        body: replay.body as unknown,
        replayed: replay.headers['idempotent-replayed'],
      }).toStrictEqual({ status: 200, body: first.body as unknown, replayed: 'true' });
      const reused = await save(alice, studyId, 1, [{ nodeId: a, x: 9, y: 9 }], key);
      expect({ status: reused.status, body: reused.body as unknown }).toStrictEqual({
        status: 422,
        body: KEY_REUSED,
      });
      expect(await ownerRows(alice)).toStrictEqual(after);
    });

    it('refuses saves on an archived or trashed study with 422, writing nothing', async () => {
      for (const [change, refusal] of [
        ['archive', STUDY_ARCHIVED],
        ['trash', STUDY_TRASHED],
      ] as const) {
        const studyId = (await createStudy(alice)).studyId;
        const a = await thought(alice, studyId);
        await lifecycle(alice, studyId, change);
        const before = await ownerRows(alice);
        const res = await save(alice, studyId, 1, [{ nodeId: a, x: 1, y: 1 }]);
        expect({ status: res.status, body: res.body as unknown }).toStrictEqual({
          status: 422,
          body: refusal,
        });
        expect(await ownerRows(alice)).toStrictEqual(before);
      }
    });

    it('never conflicts with content edits: a node create, a connect and a node edit sent with the revisions held before a position save all succeed', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const held = await studyRevision(studyId);
      expect(
        (
          await save(alice, studyId, 1, [
            { nodeId: a, x: 1, y: 1 },
            { nodeId: b, x: 2, y: 2 },
          ])
        ).status,
      ).toBe(200);
      const created = await send(alice, 'post', nodesPath(studyId), {
        expectedRevision: held,
        type: 'thought',
        text: 'Added in another tab',
      });
      expect(created.status).toBe(201);
      const edited = await send(alice, 'patch', `${nodesPath(studyId)}/${a}`, {
        expectedRevision: 1,
        text: 'Edited in another tab',
      });
      expect(edited.status).toBe(200);
      // Positions in between again: the next content edit still uses the study revision only.
      expect((await save(alice, studyId, 2, [{ nodeId: a, x: 3, y: 3 }])).status).toBe(200);
      const connected = await send(alice, 'post', edgesPath(studyId), {
        expectedRevision: (created.body as CreateNodeResponse).studyRevision,
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      expect(connected.status).toBe(201);
    });

    it('two tabs saving from one view revision: one 200, the other 409 with the new view revision, and its resend with that revision and a new key succeeds', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      // Neither tab has a view-state row yet: the lazy create is serialized by the study lock.
      const tabs = [[{ nodeId: a, x: 1, y: 1 }], [{ nodeId: b, x: 2, y: 2 }]];
      const answers = await Promise.all(
        tabs.map((positions) => save(alice, studyId, 1, positions)),
      );
      const sorted = answers
        .map((res) => ({ status: res.status, body: res.body as unknown }))
        .sort((p, q) => p.status - q.status);
      expect(sorted).toStrictEqual([
        { status: 200, body: { viewRevision: 2, lastEventSequence: anySequence } },
        { status: 409, body: conflict(2) },
      ]);
      // The losing tab resends its own positions once, with the view revision it was told.
      const loser = tabs[answers.findIndex((res) => res.status === 409)] ?? [];
      const resent = await save(alice, studyId, 2, loser);
      expect({ status: resent.status, body: resent.body as unknown }).toStrictEqual({
        status: 200,
        body: { viewRevision: 3, lastEventSequence: anySequence },
      });
      expect((await graph(alice, studyId)).positions).toStrictEqual(
        [
          { nodeId: a, x: 1, y: 1 },
          { nodeId: b, x: 2, y: 2 },
        ].sort((p, q) => (p.nodeId < q.nodeId ? -1 : 1)),
      );
      expect(await StudyViewState.count({ where: { studyId } })).toBe(1);
    });

    it('PATCH /v1/studies/:studyId/positions gives another user the same neutral 404 as an absent or malformed study, writing nothing', async () => {
      const studyId = (await createStudy(alice)).studyId;
      const a = await thought(alice, studyId);
      const bobStudy = (await createStudy(bob)).studyId;
      const before = { alice: await ownerRows(alice), bob: await ownerRows(bob) };
      const body = { expectedRevision: 1, positions: [{ nodeId: a, x: 1, y: 1 }] };
      const answers = [
        await send(bob, 'patch', positionsPath(studyId), body, randomUUID()),
        await send(bob, 'patch', positionsPath(randomUUID()), body, randomUUID()),
        await send(bob, 'patch', positionsPath('not-a-study'), body, randomUUID()),
        // Bob's own study with Alice's node: the node is not his, the same 404.
        await send(bob, 'patch', positionsPath(bobStudy), body, randomUUID()),
      ].map((res) => ({ status: res.status, body: res.body as unknown }));
      expect(answers).toStrictEqual(Array(4).fill({ status: 404, body: NOT_FOUND }));
      expect({ alice: await ownerRows(alice), bob: await ownerRows(bob) }).toStrictEqual(before);
      const anonymous = await send(null, 'patch', positionsPath(studyId), body);
      expect({ status: anonymous.status, body: anonymous.body as unknown }).toStrictEqual({
        status: 401,
        body: UNAUTHENTICATED,
      });
    });
  });

  describe('at the caps (2,000 nodes, 6,000 edges)', () => {
    it('returns every node, edge and position with the same fixed number of statements as a tiny study, each served by an index', async () => {
      const tiny = (await createStudy(alice)).studyId;
      await thought(alice, tiny);
      const counted = await recordingStatements(() => graph(alice, tiny));

      const studyId = (await createStudy(alice)).studyId;
      const scope = [studyId, alice.user.id];
      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         SELECT $1, $2, 'thought', 'user', 'Seed thought ' || g FROM generate_series(1, 2000) g`,
        { bind: scope, type: QueryTypes.INSERT },
      );
      await db.query(
        `WITH n AS (SELECT id, row_number() OVER (ORDER BY id) AS i FROM study_node WHERE study_id = $1)
         INSERT INTO study_edge (study_id, owner_id, source_node_id, target_node_id, type, origin)
         SELECT $1, $2, a.id, b.id, 'supports', 'user'
           FROM n a JOIN n b ON b.i - a.i IN (1, 2, 3) OR (b.i - a.i = 4 AND a.i <= 6)`,
        { bind: scope, type: QueryTypes.INSERT },
      );
      await db.query(
        `INSERT INTO study_node_position (study_id, owner_id, node_id, x, y)
         SELECT $1, $2, id, row_number() OVER (ORDER BY id) * 10, 0
           FROM study_node WHERE study_id = $1`,
        { bind: scope, type: QueryTypes.INSERT },
      );
      await db.query('ANALYZE study_node; ANALYZE study_edge; ANALYZE study_node_position;');

      const started = Date.now();
      const big = await recordingStatements(() => graph(alice, studyId));
      const elapsed = Date.now() - started;
      expect({
        nodes: big.result.nodes.length,
        edges: big.result.edges.length,
        positions: big.result.positions.length,
        statements: big.sql.length,
      }).toStrictEqual({
        nodes: 2000,
        edges: 6000,
        positions: 2000,
        statements: counted.sql.length,
      });

      // Query-plan evidence: every snapshot read of the three graph tables can be answered from
      // an index on its study (the planner may still prefer a sequential scan when one study is
      // most of a test table, so the check disables that option, as PostgreSQL's
      // `enable_seqscan` is meant for).
      const graphReads = big.sql.filter((sql) =>
        /FROM "(study_node|study_edge|study_node_position)"/.test(sql),
      );
      expect(graphReads).toHaveLength(3);
      for (const sql of graphReads) {
        const plan = await db.transaction(async () => {
          await db.query('SET LOCAL enable_seqscan = off');
          const rows = await db.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN ${sql.replace(/;\s*$/, '')}`,
            { type: QueryTypes.SELECT },
          );
          return rows.map((line) => line['QUERY PLAN']).join('\n');
        });
        expect(plan).not.toMatch(/Seq Scan/);
        expect(plan).toMatch(/Index|Bitmap/);
      }
      process.stdout.write(
        `[BIB-28] GET /graph at 2,000 nodes / 6,000 edges / 2,000 positions: ${elapsed} ms, ${big.sql.length} statements\n`,
      );
    }, 60_000);
  });
});
