import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateEdgeResponse,
  CreateNodeResponse,
  CreateStudyResponse,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
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

const STUDIES = '/v1/studies';
const nodesPath = (studyId: string): string => `${STUDIES}/${studyId}/nodes`;
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const edgesPath = (studyId: string): string => `/v1/studies/${studyId}/edges`;
const edgePath = (studyId: string, edgeId: string): string =>
  `/v1/studies/${studyId}/edges/${edgeId}`;
const listPath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/edges?nodeId=${encodeURIComponent(nodeId)}`;

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
const TARGET_NOT_QUESTION = envelope({
  code: 'EDGE_TARGET_NOT_QUESTION',
  message: 'This relationship must point to a question',
});
const LIMIT_EXCEEDED = envelope({
  code: 'EDGE_LIMIT_EXCEEDED',
  message: 'A study can hold at most 6,000 relationships',
});
const TYPE_CHANGE_NOT_ALLOWED = envelope({
  code: 'EDGE_TYPE_CHANGE_NOT_ALLOWED',
  message:
    'A relationship can only change to a type with the same direction. Remove it and connect again',
});
const EDGE_EXISTS = envelope({
  code: 'EDGE_EXISTS',
  message: 'These nodes already have this relationship',
});
const EDGE_UNCHANGED = envelope({
  code: 'EDGE_UNCHANGED',
  message: 'The relationship already has these values',
});

/** BIB-27: typed, directional relationships. Real PostgreSQL, whole-body assertions. */
describe('typed relationships (BIB-27)', () => {
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

  /** Sends one request (with an optional Idempotency-Key) and starts it immediately. */
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

  async function createStudy(owner: Owner): Promise<string> {
    const res = await send(owner, 'post', STUDIES, { blank: true });
    expect(res.status).toBe(201);
    return (res.body as CreateStudyResponse).studyId;
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  /** Creates a node through the API at the study's current revision; returns its id. */
  async function createNode(owner: Owner, studyId: string, body: object): Promise<string> {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  const observation = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, {
      type: 'observation',
      text: 'Paul appeals to conscience',
      observationKind: 'textual_observation',
    });
  const conclusion = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, { type: 'conclusion', text: 'Conscience testifies' });
  const question = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, { type: 'question', text: 'What is conscience?' });
  const thought = (owner: Owner, studyId: string) =>
    createNode(owner, studyId, { type: 'thought', text: 'Maybe a second witness' });

  /** Connects at the study's current revision unless the body names one. */
  async function connect(
    owner: Owner,
    studyId: string,
    body: Record<string, unknown>,
    key?: string,
  ): Promise<Response> {
    return send(
      owner,
      'post',
      edgesPath(studyId),
      { expectedRevision: await studyRevision(studyId), ...body },
      key,
    );
  }

  async function connected(owner: Owner, studyId: string, body: Record<string, unknown>) {
    const res = await connect(owner, studyId, body);
    expect(res.status).toBe(201);
    return res.body as CreateEdgeResponse;
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: e.payloadJson,
    }));
  }

  async function lastEvent(studyId: string) {
    return (await events(studyId)).at(-1);
  }

  /** Every row an edge mutation of this owner may write, to prove a request wrote nothing. */
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
        attributes: ['id', 'revision', 'deletedAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      edges: await StudyEdge.findAll({
        where,
        attributes: ['id', 'type', 'note', 'revision', 'deletedAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  /** The edge as GET lists it (from either node), for whole-body expectations. */
  const listed = (edge: CreateEdgeResponse, note: string | null, revision = 1) => ({
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    type: edge.type,
    origin: 'user',
    note,
    revision,
    createdAt: edge.createdAt,
    updatedAt: anyTime,
  });

  /** Waits until `n` other backends of this database are blocked on a lock (the gate pattern). */
  async function lockWaiters(n: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'`,
        { type: QueryTypes.SELECT },
      );
      if ((row?.n ?? 0) >= n) return;
      if (Date.now() > deadline) throw new Error('racers never blocked on the gate');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its nodes, edges and events.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('connect and read', () => {
    it('connects two live nodes with type, direction, origin and note, in one transaction with node_connected, and lists it from both nodes', async () => {
      const studyId = await createStudy(alice);
      const source = await observation(alice, studyId);
      const target = await conclusion(alice, studyId);
      const before = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const res = await connect(alice, studyId, {
        sourceNodeId: source,
        targetNodeId: target,
        type: 'supports',
        note: '  Both speak of witness.  ',
      });
      const edge = res.body as CreateEdgeResponse;
      const after = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect({
        answer: [res.status, res.body],
        study: [after.revision, after.contentRevision, after.lastEventSequence],
        event: await lastEvent(studyId),
        fromSource: (await send(alice, 'get', listPath(studyId, source))).body as unknown,
        fromTarget: (await send(alice, 'get', listPath(studyId, target))).body as unknown,
      }).toStrictEqual({
        answer: [
          201,
          {
            outcome: 'created',
            id: anyId,
            studyId,
            sourceNodeId: source,
            targetNodeId: target,
            type: 'supports',
            origin: 'user',
            revision: 1,
            createdAt: anyTime,
            updatedAt: anyTime,
            studyRevision: before.revision + 1,
            lastEventSequence: String(Number(before.lastEventSequence) + 1),
          },
        ],
        study: [
          before.revision + 1,
          before.contentRevision + 1,
          String(Number(before.lastEventSequence) + 1),
        ],
        event: {
          sequence: String(Number(before.lastEventSequence) + 1),
          eventType: 'node_connected',
          payload: {
            edgeId: edge.id,
            sourceNodeId: source,
            targetNodeId: target,
            edgeType: 'supports',
          },
        },
        fromSource: { items: [listed(edge, 'Both speak of witness.')] },
        fromTarget: { items: [listed(edge, 'Both speak of witness.')] },
      });
    });

    it('answers a repeat of the same source, target and type with 200 existing, writing nothing and ignoring its note, even from a stale revision', async () => {
      const studyId = await createStudy(alice);
      const source = await observation(alice, studyId);
      const target = await conclusion(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: source,
        targetNodeId: target,
        type: 'supports',
        note: 'First note',
      });
      const before = await ownerRows(alice);
      const current = await studyRevision(studyId);
      const body = { sourceNodeId: source, targetNodeId: target, type: 'supports', note: 'Other' };
      const answers = [
        await connect(alice, studyId, body, randomUUID()),
        // A stale study revision never conflicts with an existing edge.
        await connect(alice, studyId, { ...body, expectedRevision: 1 }, randomUUID()),
      ].map((r): unknown[] => [r.status, r.body]);
      const existing = {
        outcome: 'existing',
        id: edge.id,
        studyId,
        sourceNodeId: source,
        targetNodeId: target,
        type: 'supports',
        origin: 'user',
        revision: 1,
        createdAt: edge.createdAt,
        updatedAt: anyTime,
        studyRevision: current,
        lastEventSequence: null,
      };
      const after = await ownerRows(alice);
      expect({
        answers,
        // Only the two receipts (each response is stored) were written.
        unchanged: isDeepStrictEqual({ ...after, receipts: before.receipts }, before),
        receipts: after.receipts - before.receipts,
        list: (await send(alice, 'get', listPath(studyId, source))).body as unknown,
      }).toStrictEqual({
        answers: [
          [200, existing],
          [200, existing],
        ],
        unchanged: true,
        receipts: 2,
        list: { items: [listed(edge, 'First note')] },
      });
    });

    it('stores a two-way edge once with sorted endpoints, so the reverse order of related_to or parallels is 200 existing', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const [low, high] = [a, b].sort();
      const results: unknown[] = [];
      for (const type of ['related_to', 'parallels']) {
        const first = await connected(alice, studyId, {
          sourceNodeId: high,
          targetNodeId: low,
          type,
        });
        const eventsBefore = (await events(studyId)).length;
        const reverse = await connect(alice, studyId, {
          sourceNodeId: low,
          targetNodeId: high,
          type,
        });
        results.push({
          stored: [first.sourceNodeId, first.targetNodeId],
          reverse: [reverse.status, (reverse.body as CreateEdgeResponse).outcome],
          sameId: (reverse.body as CreateEdgeResponse).id === first.id,
          noEvent: (await events(studyId)).length === eventsBefore,
        });
      }
      const result = {
        stored: [low, high],
        reverse: [200, 'existing'],
        sameId: true,
        noEvent: true,
      };
      expect(results).toStrictEqual([result, result]);
    });

    it('creates separate edges for the reverse direction of a directed type and for another type between the same nodes', async () => {
      const studyId = await createStudy(alice);
      const a = await observation(alice, studyId);
      const b = await thought(alice, studyId);
      const answers = [
        await connect(alice, studyId, { sourceNodeId: a, targetNodeId: b, type: 'supports' }),
        await connect(alice, studyId, { sourceNodeId: b, targetNodeId: a, type: 'supports' }),
        await connect(alice, studyId, { sourceNodeId: a, targetNodeId: b, type: 'qualifies' }),
      ].map((r) => [r.status, (r.body as CreateEdgeResponse).outcome]);
      expect({
        answers,
        live: await StudyEdge.count({ where: { studyId, deletedAt: null } }),
      }).toStrictEqual({
        answers: [
          [201, 'created'],
          [201, 'created'],
          [201, 'created'],
        ],
        live: 3,
      });
    });

    it('lists a node with no relationships as empty, and answers GET without nodeId with 400 and a malformed one with 404', async () => {
      const studyId = await createStudy(alice);
      const node = await thought(alice, studyId);
      const answers = [
        await send(alice, 'get', listPath(studyId, node)),
        await send(alice, 'get', edgesPath(studyId)),
        await send(alice, 'get', listPath(studyId, 'not-a-uuid')),
        await send(alice, 'get', listPath(studyId, randomUUID())),
      ].map((r): unknown[] => [r.status, r.body]);
      expect(answers).toStrictEqual([
        [200, { items: [] }],
        [400, invalid({ nodeId: [expect.any(String) as string] })],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
    });
  });

  describe('refused connects write nothing', () => {
    it('refuses a self-edge with 400, and an endpoint that is absent, malformed, deleted, of another study or of another user with 404', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const deleted = await thought(alice, studyId);
      await StudyNode.update({ deletedAt: new Date() }, { where: { id: deleted } });
      const otherStudy = await createStudy(alice);
      const elsewhere = await thought(alice, otherStudy);
      const bobsStudy = await createStudy(bob);
      const bobs = await thought(bob, bobsStudy);
      const before = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const to = (targetNodeId: string, sourceNodeId = a) =>
        connect(alice, studyId, { sourceNodeId, targetNodeId, type: 'supports' });
      const answers = [
        await to(a),
        await to(a.toUpperCase()),
        await to(randomUUID()),
        await to('not-a-uuid'),
        await to(deleted),
        await to(elsewhere),
        await to(bobs),
        await to(a, bobs),
      ].map((r): unknown[] => [r.status, r.body]);
      const selfEdge = invalid({ targetNodeId: ['Choose two different nodes'] });
      expect({
        answers,
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), before),
        bobUnchanged: isDeepStrictEqual(await ownerRows(bob), bobBefore),
      }).toStrictEqual({
        answers: [
          [400, selfEdge],
          [400, selfEdge],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
        ],
        aliceUnchanged: true,
        bobUnchanged: true,
      });
    });

    it('needs a Question target for answers and raises_question (422 otherwise), and allows every other type between any node types', async () => {
      const studyId = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const q = await question(alice, studyId);
      const c = await conclusion(alice, studyId);
      const before = await ownerRows(alice);
      const refused = [
        await connect(alice, studyId, { sourceNodeId: obs, targetNodeId: c, type: 'answers' }),
        await connect(alice, studyId, {
          sourceNodeId: q,
          targetNodeId: obs,
          type: 'raises_question',
        }),
      ].map((r): unknown[] => [r.status, r.body]);
      const unchanged = isDeepStrictEqual(await ownerRows(alice), before);
      const allowed = [
        await connect(alice, studyId, { sourceNodeId: obs, targetNodeId: q, type: 'answers' }),
        await connect(alice, studyId, {
          sourceNodeId: c,
          targetNodeId: q,
          type: 'raises_question',
        }),
        await connect(alice, studyId, { sourceNodeId: c, targetNodeId: obs, type: 'fulfillment' }),
        // Cycles are valid.
        await connect(alice, studyId, { sourceNodeId: q, targetNodeId: c, type: 'inference_from' }),
      ].map((r) => r.status);
      expect({ refused, unchanged, allowed }).toStrictEqual({
        refused: [
          [422, TARGET_NOT_QUESTION],
          [422, TARGET_NOT_QUESTION],
        ],
        unchanged: true,
        allowed: [201, 201, 201, 201],
      });
    });

    it('refuses a new edge at 6,000 live edges with 422 while an existing one still answers 200; removed edges do not count', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const first = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      // 80 filler nodes give 6,320 ordered pairs; 5,999 live `supports` edges plus the one above.
      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         SELECT $1, $2, 'thought', 'user', 'Filler' FROM generate_series(1, 80)`,
        { bind: [studyId, alice.user.id] },
      );
      await db.query(
        `INSERT INTO study_edge (study_id, owner_id, source_node_id, target_node_id, type, origin)
         SELECT $1, $2, s.id, t.id, 'supports', 'user'
           FROM study_node s JOIN study_node t ON s.id <> t.id
          WHERE s.study_id = $1 AND t.study_id = $1 AND s.body = 'Filler' AND t.body = 'Filler'
          LIMIT 5999`,
        { bind: [studyId, alice.user.id] },
      );
      const before = await ownerRows(alice);
      const refused = await connect(alice, studyId, {
        sourceNodeId: b,
        targetNodeId: a,
        type: 'supports',
      });
      const unchanged = isDeepStrictEqual(await ownerRows(alice), before);
      const existing = await connect(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      await db.query(
        `UPDATE study_edge SET deleted_at = now() WHERE id = (
           SELECT id FROM study_edge WHERE study_id = $1 AND id <> $2 LIMIT 1)`,
        { bind: [studyId, first.id] },
      );
      const afterRemoval = await connect(alice, studyId, {
        sourceNodeId: b,
        targetNodeId: a,
        type: 'supports',
      });
      expect({
        refused: [refused.status, refused.body],
        unchanged,
        existing: [existing.status, (existing.body as CreateEdgeResponse).outcome],
        afterRemoval: afterRemoval.status,
      }).toStrictEqual({
        refused: [422, LIMIT_EXCEEDED],
        unchanged: true,
        existing: [200, 'existing'],
        afterRemoval: 201,
      });
    });

    it('refuses a missing expectedRevision with 428 and a stale one with 409 on POST, PATCH and DELETE, writing nothing', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      const current = await studyRevision(studyId);
      const before = await ownerRows(alice);
      const fresh = { sourceNodeId: b, targetNodeId: a, type: 'supports' };
      const answers = [
        await send(alice, 'post', edgesPath(studyId), fresh),
        await send(alice, 'post', edgesPath(studyId), { ...fresh, expectedRevision: current - 1 }),
        await send(alice, 'patch', edgePath(studyId, edge.id), { note: 'x' }),
        await send(alice, 'patch', edgePath(studyId, edge.id), { expectedRevision: 2, note: 'x' }),
        await send(alice, 'delete', edgePath(studyId, edge.id), {}),
        await send(alice, 'delete', edgePath(studyId, edge.id), { expectedRevision: 2 }),
      ].map((r): unknown[] => [r.status, r.body]);
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [428, REVISION_MISSING],
          [409, conflict(current)],
          [428, REVISION_MISSING],
          [409, conflict(1)],
          [428, REVISION_MISSING],
          [409, conflict(1)],
        ],
        unchanged: true,
      });
    });
  });

  describe('edit and remove', () => {
    it('changes the note (and clears it with null) with edge_updated keeping the previous type, and retypes within the direction class', async () => {
      const studyId = await createStudy(alice);
      const a = await observation(alice, studyId);
      const b = await conclusion(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      const contentBefore = (await Study.findByPk(studyId, { rejectOnEmpty: true }))
        .contentRevision;
      const noted = await send(alice, 'patch', edgePath(studyId, edge.id), {
        expectedRevision: 1,
        note: 'Because of witness',
      });
      const noteEvent = await lastEvent(studyId);
      const retyped = await send(alice, 'patch', edgePath(studyId, edge.id), {
        expectedRevision: 2,
        type: 'qualifies',
      });
      const retypeEvent = await lastEvent(studyId);
      const cleared = await send(alice, 'patch', edgePath(studyId, edge.id), {
        expectedRevision: 3,
        note: null,
      });
      const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const saved = (revision: number, type: string, sequence: string) => ({
        id: edge.id,
        studyId,
        sourceNodeId: a,
        targetNodeId: b,
        type,
        origin: 'user',
        revision,
        createdAt: edge.createdAt,
        updatedAt: anyTime,
        lastEventSequence: sequence,
        establishmentClearedNodeIds: [],
      });
      const seq = Number(edge.lastEventSequence);
      expect({
        noted: [noted.status, noted.body],
        noteEvent,
        retyped: [retyped.status, retyped.body],
        retypeEvent,
        cleared: [cleared.status, cleared.body],
        contentRevision: study.contentRevision - contentBefore,
        list: (await send(alice, 'get', listPath(studyId, b))).body as unknown,
      }).toStrictEqual({
        noted: [200, saved(2, 'supports', String(seq + 1))],
        noteEvent: {
          sequence: String(seq + 1),
          eventType: 'edge_updated',
          payload: {
            edgeId: edge.id,
            edgeType: 'supports',
            previousEdgeType: 'supports',
            noteChanged: true,
          },
        },
        retyped: [200, saved(3, 'qualifies', String(seq + 2))],
        retypeEvent: {
          sequence: String(seq + 2),
          eventType: 'edge_updated',
          payload: {
            edgeId: edge.id,
            edgeType: 'qualifies',
            previousEdgeType: 'supports',
            noteChanged: false,
          },
        },
        cleared: [200, saved(4, 'qualifies', String(seq + 3))],
        contentRevision: 3,
        list: { items: [{ ...listed({ ...edge, type: 'qualifies' }, null, 4) }] },
      });
    });

    it('refuses a retype across direction classes, into a non-Question target, into another live edge type, or with no change (422), and a stale one first with 409', async () => {
      const studyId = await createStudy(alice);
      const a = await observation(alice, studyId);
      const b = await conclusion(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
        note: 'Kept',
      });
      await connected(alice, studyId, { sourceNodeId: a, targetNodeId: b, type: 'explains' });
      const two = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'related_to',
      });
      const before = await ownerRows(alice);
      const patch = (edgeId: string, body: object) =>
        send(alice, 'patch', edgePath(studyId, edgeId), { expectedRevision: 1, ...body });
      const answers = [
        await patch(edge.id, { type: 'related_to' }),
        await patch(two.id, { type: 'supports' }),
        await patch(edge.id, { type: 'answers' }),
        await patch(edge.id, { type: 'explains' }),
        await patch(edge.id, { type: 'supports', note: '  Kept ' }),
        await patch(edge.id, { note: 'Kept' }),
        await send(alice, 'patch', edgePath(studyId, edge.id), {
          expectedRevision: 9,
          type: 'related_to',
        }),
        await patch(edge.id, { type: 'supports', sourceNodeId: b }),
        await patch(edge.id, {}),
      ].map((r): unknown[] => [r.status, r.body]);
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [422, TYPE_CHANGE_NOT_ALLOWED],
          [422, TYPE_CHANGE_NOT_ALLOWED],
          [422, TARGET_NOT_QUESTION],
          [422, EDGE_EXISTS],
          [422, EDGE_UNCHANGED],
          [422, EDGE_UNCHANGED],
          [409, conflict(1)],
          [400, expect.objectContaining({ code: 'VALIDATION' }) as unknown],
          [400, invalid({ _: ['Send a type or a note to change'] })],
        ],
        unchanged: true,
      });
    });

    it('removes an edge (soft delete, edge_removed), keeps both nodes, lets the same edge be connected again, and answers a second remove with 404', async () => {
      const studyId = await createStudy(alice);
      const a = await observation(alice, studyId);
      const b = await conclusion(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      const removed = await send(alice, 'delete', edgePath(studyId, edge.id), {
        expectedRevision: 1,
      });
      const removedEvent = await lastEvent(studyId);
      const row = await StudyEdge.findByPk(edge.id, { rejectOnEmpty: true });
      const nodes = (await send(alice, 'get', nodesPath(studyId))).body as { items: unknown[] };
      const list = (await send(alice, 'get', listPath(studyId, a))).body as unknown;
      const again = await send(alice, 'delete', edgePath(studyId, edge.id), {
        expectedRevision: 2,
      });
      const reconnected = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      expect({
        removed: [removed.status, removed.body],
        removedEvent,
        deleted: row.deletedAt instanceof Date,
        nodes: nodes.items.length,
        list,
        again: [again.status, again.body],
        reconnected: reconnected.id !== edge.id,
      }).toStrictEqual({
        removed: [
          200,
          {
            id: edge.id,
            studyId,
            sourceNodeId: a,
            targetNodeId: b,
            type: 'supports',
            origin: 'user',
            revision: 2,
            createdAt: edge.createdAt,
            updatedAt: anyTime,
            lastEventSequence: String(Number(edge.lastEventSequence) + 1),
            establishmentClearedNodeIds: [],
          },
        ],
        removedEvent: {
          sequence: String(Number(edge.lastEventSequence) + 1),
          eventType: 'edge_removed',
          payload: { edgeId: edge.id, sourceNodeId: a, targetNodeId: b, edgeType: 'supports' },
        },
        deleted: true,
        nodes: 2,
        list: { items: [] },
        again: [404, NOT_FOUND],
        reconnected: true,
      });
    });

    it('refuses every edge mutation on an archived or trashed study with 422, writing nothing, while the edges stay readable', async () => {
      const answersFor = async (lifecycle: 'archive' | 'trash') => {
        const studyId = await createStudy(alice);
        const a = await thought(alice, studyId);
        const b = await thought(alice, studyId);
        const edge = await connected(alice, studyId, {
          sourceNodeId: a,
          targetNodeId: b,
          type: 'supports',
        });
        const revision = await studyRevision(studyId);
        const res =
          lifecycle === 'archive'
            ? await send(alice, 'post', `${STUDIES}/${studyId}/archive`, {
                expectedRevision: revision,
              })
            : await send(alice, 'delete', `${STUDIES}/${studyId}`, { expectedRevision: revision });
        expect(res.status).toBe(200);
        const before = await ownerRows(alice);
        const next = revision + 1;
        const answers = [
          await send(alice, 'post', edgesPath(studyId), {
            expectedRevision: next,
            sourceNodeId: b,
            targetNodeId: a,
            type: 'supports',
          }),
          // Even a duplicate (which would write nothing) is refused by the lifecycle guard.
          await send(alice, 'post', edgesPath(studyId), {
            expectedRevision: next,
            sourceNodeId: a,
            targetNodeId: b,
            type: 'supports',
          }),
          await send(alice, 'patch', edgePath(studyId, edge.id), {
            expectedRevision: 1,
            note: 'x',
          }),
          await send(alice, 'delete', edgePath(studyId, edge.id), { expectedRevision: 1 }),
        ].map((r): unknown[] => [r.status, r.body]);
        const read = await send(alice, 'get', listPath(studyId, a));
        return {
          answers,
          read: [read.status, (read.body as { items: unknown[] }).items.length],
          unchanged: isDeepStrictEqual(await ownerRows(alice), before),
        };
      };
      const expected = (refusal: unknown) => ({
        answers: [
          [422, refusal],
          [422, refusal],
          [422, refusal],
          [422, refusal],
        ],
        read: [200, 1],
        unchanged: true,
      });
      expect(await answersFor('archive')).toStrictEqual(expected(STUDY_ARCHIVED));
      expect(await answersFor('trash')).toStrictEqual(expected(STUDY_TRASHED));
    });
  });

  describe('idempotency and concurrency', () => {
    it('replays a created connect with the same key and body (one edge, one event), replays an existing answer too, and rejects the key with another body', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const key = randomUUID();
      const body = {
        expectedRevision: await studyRevision(studyId),
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      };
      const first = await send(alice, 'post', edgesPath(studyId), body, key);
      const eventsAfterFirst = (await events(studyId)).length;
      const replay = await send(alice, 'post', edgesPath(studyId), body, key);
      const existingKey = randomUUID();
      const existing = await send(alice, 'post', edgesPath(studyId), body, existingKey);
      const existingReplay = await send(alice, 'post', edgesPath(studyId), body, existingKey);
      const reused = await send(
        alice,
        'post',
        edgesPath(studyId),
        { ...body, type: 'qualifies' },
        key,
      );
      expect({
        first: first.status,
        replay: [replay.status, replay.headers['idempotent-replayed'], replay.body],
        existing: [existing.status, (existing.body as CreateEdgeResponse).outcome],
        existingReplay: [
          existingReplay.status,
          existingReplay.headers['idempotent-replayed'],
          existingReplay.body,
        ],
        reused: [reused.status, reused.body],
        events: (await events(studyId)).length - eventsAfterFirst,
        live: await StudyEdge.count({ where: { studyId } }),
      }).toStrictEqual({
        first: 201,
        replay: [201, 'true', first.body],
        existing: [200, 'existing'],
        existingReplay: [200, 'true', existing.body],
        reused: [422, KEY_REUSED],
        events: 0,
        live: 1,
      });
    });

    // The dedup lookup runs before the study revision check (a duplicate never conflicts), so the
    // racer that queues behind the creator finds its committed edge: 200 existing, not 409.
    it('lets one of two simultaneous identical connects from one revision create the edge; the other finds it and answers 200 existing', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const body = {
        expectedRevision: await studyRevision(studyId),
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      };
      const gate = await db.transaction();
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [studyId],
        transaction: gate,
      });
      const pending = [
        send(alice, 'post', edgesPath(studyId), body, randomUUID()),
        send(alice, 'post', edgesPath(studyId), body, randomUUID()),
      ];
      await lockWaiters(2);
      await gate.rollback();
      const results = await Promise.all(pending);
      const statuses = results.map((r) => r.status).sort();
      const retry = await connect(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
      });
      expect({
        statuses,
        retry: [retry.status, (retry.body as CreateEdgeResponse).outcome],
        live: await StudyEdge.count({ where: { studyId, deletedAt: null } }),
        connectedEvents: (await events(studyId)).filter((e) => e.eventType === 'node_connected')
          .length,
      }).toStrictEqual({
        statuses: [200, 201],
        retry: [200, 'existing'],
        live: 1,
        connectedEvents: 1,
      });
    });
    it('still checks the study revision for a new edge: two different connects from one revision are one 201 and one 409', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const expectedRevision = await studyRevision(studyId);
      const gate = await db.transaction();
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [studyId],
        transaction: gate,
      });
      const pending = ['supports', 'qualifies'].map((type) =>
        send(alice, 'post', edgesPath(studyId), {
          expectedRevision,
          sourceNodeId: a,
          targetNodeId: b,
          type,
        }),
      );
      await lockWaiters(2);
      await gate.rollback();
      const results = await Promise.all(pending);
      expect({
        statuses: results.map((r) => r.status).sort(),
        live: await StudyEdge.count({ where: { studyId, deletedAt: null } }),
      }).toStrictEqual({ statuses: [201, 409], live: 1 });
    });
  });

  describe('owner isolation', () => {
    /**
     * Alice's study with an edge; Bob calls the route on her study and edge, on an absent and a
     * malformed edge id, on her edge under his own study, and Alice addresses her edge under
     * another of her studies; finally no session. Returns every answer plus whether either
     * owner's rows changed.
     */
    async function crossUserAnswers(
      method: 'patch' | 'delete',
      path: (studyId: string, edgeId: string) => string,
      body: object,
    ) {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const edge = await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
        note: 'Alice private note',
      });
      const aliceOther = await createStudy(alice);
      const bobsStudy = await createStudy(bob);
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const answers = [
        await send(bob, method, path(studyId, edge.id), body),
        await send(bob, method, path(studyId, randomUUID()), body),
        await send(bob, method, path(studyId, 'not-a-uuid'), body),
        await send(bob, method, path(bobsStudy, edge.id), body),
        await send(alice, method, path(aliceOther, edge.id), body),
        await send(null, method, path(studyId, edge.id), body),
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
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [401, UNAUTHENTICATED],
      ],
      aliceUnchanged: true,
      bobUnchanged: true,
    };

    it('POST /v1/studies/:studyId/edges gives another user the same neutral 404 as an absent or malformed study, and never connects their nodes, writing nothing', async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      const bobsStudy = await createStudy(bob);
      const bobsNode = await thought(bob, bobsStudy);
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const body = { expectedRevision: 3, sourceNodeId: a, targetNodeId: b, type: 'supports' };
      const answers = [
        await send(bob, 'post', edgesPath(studyId), body),
        await send(bob, 'post', edgesPath(randomUUID()), body),
        await send(bob, 'post', edgesPath('not-a-uuid'), body),
        // Alice's nodes under Bob's own study.
        await send(bob, 'post', edgesPath(bobsStudy), {
          ...body,
          expectedRevision: await studyRevision(bobsStudy),
          sourceNodeId: bobsNode,
          targetNodeId: a,
        }),
        await send(null, 'post', edgesPath(studyId), body),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({
        answers,
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), aliceBefore),
        bobUnchanged: isDeepStrictEqual(await ownerRows(bob), bobBefore),
      }).toStrictEqual({
        answers: [
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [401, UNAUTHENTICATED],
        ],
        aliceUnchanged: true,
        bobUnchanged: true,
      });
    });

    it("GET /v1/studies/:studyId/edges lists nothing of another user's: their study and node are the same 404 as absent ones", async () => {
      const studyId = await createStudy(alice);
      const a = await thought(alice, studyId);
      const b = await thought(alice, studyId);
      await connected(alice, studyId, {
        sourceNodeId: a,
        targetNodeId: b,
        type: 'supports',
        note: 'Alice private note',
      });
      const aliceOther = await createStudy(alice);
      const bobsStudy = await createStudy(bob);
      const answers = [
        await send(bob, 'get', listPath(studyId, a)),
        await send(bob, 'get', listPath(randomUUID(), a)),
        await send(bob, 'get', listPath('not-a-uuid', a)),
        await send(bob, 'get', listPath(bobsStudy, a)),
        await send(alice, 'get', listPath(aliceOther, a)),
        await send(null, 'get', listPath(studyId, a)),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(answers).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [401, UNAUTHENTICATED],
      ]);
    });

    it('PATCH /v1/studies/:studyId/edges/:edgeId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('patch', edgePath, { expectedRevision: 1, note: 'Bob' }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('DELETE /v1/studies/:studyId/edges/:edgeId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(await crossUserAnswers('delete', edgePath, { expectedRevision: 1 })).toStrictEqual(
        CROSS_USER_ANSWERS,
      );
    });
  });
});
