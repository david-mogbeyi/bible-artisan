import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateEdgeResponse,
  CreateNodeResponse,
  CreateStudyResponse,
  DeletedNodeListResponse,
  NodeListResponse,
  NodeResponse,
  NodeVersionListResponse,
  ResolveReferenceResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { NodeVersion } from '../src/database/models/node-version.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNodePosition } from '../src/database/models/study-node-position.model';
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
const anySequence: unknown = expect.stringMatching(/^\d+$/);
const DUP_KEY = randomUUID();
const DELETE_KEY = randomUUID();

const STUDIES = '/v1/studies';
const nodesPath = (studyId: string): string => `${STUDIES}/${studyId}/nodes`;
const nodePath = (studyId: string, nodeId: string): string => `${nodesPath(studyId)}/${nodeId}`;
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const duplicatePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}/duplicate`;
const restorePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}/restore`;
const deletePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}`;
const edgesPath = (studyId: string): string => `${STUDIES}/${studyId}/edges`;
const edgePath = (studyId: string, edgeId: string): string => `${edgesPath(studyId)}/${edgeId}`;

const NODE_UNCHANGED = envelope({
  code: 'NODE_UNCHANGED',
  message: 'The node already has these values',
});
const NODE_NOT_EDITABLE = envelope({
  code: 'NODE_NOT_EDITABLE',
  message: 'This node cannot be edited this way',
});
const NODE_NOT_DUPLICABLE = envelope({
  code: 'NODE_NOT_DUPLICABLE',
  message: 'Use Add a separate copy to duplicate a passage.',
});
const NODE_NOT_DELETED = envelope({
  code: 'NODE_NOT_DELETED',
  message: "This node isn't deleted.",
});
const NODE_LIMIT = envelope({
  code: 'NODE_LIMIT_EXCEEDED',
  message: 'A study can hold at most 2,000 nodes',
});
const conflict = (currentRevision: number) =>
  envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision });
const REVISION_MISSING = envelope({
  code: 'REVISION_MISSING',
  message: 'expectedRevision is required',
});
const KEY_REUSED = envelope({
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});
const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });

/** BIB-62 (observation marker), BIB-61 (duplicate) and BIB-31 (delete and restore). */
describe('node lifecycle: establish observations, duplicate, delete and restore', () => {
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

  async function createStudy(owner: Owner, body: object = { blank: true }) {
    const res = await send(owner, 'post', STUDIES, body);
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  const studyOf = (studyId: string) => Study.findByPk(studyId, { rejectOnEmpty: true });
  const revisionOf = async (nodeId: string) =>
    (await StudyNode.findByPk(nodeId, { rejectOnEmpty: true })).revision;

  async function createNode(owner: Owner, studyId: string, body: object): Promise<string> {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: (await studyOf(studyId)).revision,
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  const observation = (owner: Owner, studyId: string, text = 'Paul appeals to conscience') =>
    createNode(owner, studyId, {
      type: 'observation',
      text,
      observationKind: 'textual_observation',
    });
  const conclusion = (owner: Owner, studyId: string, text = 'Conscience is a moral witness') =>
    createNode(owner, studyId, { type: 'conclusion', text });
  const thought = (owner: Owner, studyId: string, text = 'A thought') =>
    createNode(owner, studyId, { type: 'thought', text });

  async function connect(
    owner: Owner,
    studyId: string,
    sourceNodeId: string,
    targetNodeId: string,
    type: string,
  ): Promise<string> {
    const res = await send(owner, 'post', edgesPath(studyId), {
      expectedRevision: (await studyOf(studyId)).revision,
      sourceNodeId,
      targetNodeId,
      type,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateEdgeResponse).id;
  }

  async function patch(owner: Owner, studyId: string, nodeId: string, body: object) {
    return send(owner, 'patch', nodePath(studyId, nodeId), {
      expectedRevision: await revisionOf(nodeId),
      ...body,
    });
  }

  /** Supported and established, through the owner's PATCHes (needs live support). */
  async function establishConclusion(owner: Owner, studyId: string, nodeId: string) {
    expect((await patch(owner, studyId, nodeId, { status: 'supported' })).status).toBe(200);
    expect((await patch(owner, studyId, nodeId, { establishment: 'set' })).status).toBe(200);
  }

  const detail = async (owner: Owner, studyId: string, nodeId: string) =>
    (await send(owner, 'get', nodePath(studyId, nodeId))).body as NodeResponse;

  async function eventsSince(studyId: string, after: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows
      .filter((e) => BigInt(e.sequence) > BigInt(after))
      .map((e) => ({ eventType: e.eventType, payload: e.payloadJson }));
  }

  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: ['id', 'revision', 'contentRevision', 'lastEventSequence'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      nodes: await StudyNode.findAll({
        where,
        attributes: ['id', 'revision', 'deletedAt', 'establishedAt', 'canonicalNodeId'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      edges: await StudyEdge.findAll({
        where,
        attributes: ['id', 'revision', 'deletedAt', 'deletedWithNodeId'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      versions: await NodeVersion.count({ where }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const res = await send(alice, 'post', '/v1/bible/resolve', {
      input: 'Romans 9:1',
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

  describe('observations marked "Established by me" (BIB-62)', () => {
    it('marks and unmarks only on the owner’s PATCH with no evidence needed, clears the marker on an edit with a warning, and shows it in every list', async () => {
      const { studyId } = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const before = await studyOf(studyId);

      const set = await patch(alice, studyId, obs, { establishment: 'set' });
      expect([set.status, set.body]).toStrictEqual([
        200,
        {
          id: obs,
          studyId,
          type: 'observation',
          origin: 'user',
          revision: 2,
          referenceId: null,
          createdAt: anyTime,
          updatedAt: anyTime,
          lastEventSequence: anySequence,
          versionId: null,
          previousVersionId: null,
          warnings: [],
        },
      ]);
      const afterSet = await studyOf(studyId);
      expect(afterSet.contentRevision).toBe(before.contentRevision + 1);
      expect(await eventsSince(studyId, before.lastEventSequence)).toStrictEqual([
        {
          eventType: 'observation_established',
          payload: { nodeId: obs, observationKind: 'textual_observation' },
        },
      ]);
      const shown = await detail(alice, studyId, obs);
      expect(shown.type === 'observation' && shown.establishedAt).toMatch(ISO);
      const list = (await send(alice, 'get', nodesPath(studyId))).body as NodeListResponse;
      expect(list.items.map((n) => [n.id, n.established, n.evidenceIncomplete])).toStrictEqual([
        [obs, true, false],
      ]);
      const graph = (await send(alice, 'get', `${STUDIES}/${studyId}/graph`)).body as {
        nodes: { established: boolean }[];
      };
      expect(graph.nodes.map((n) => n.established)).toStrictEqual([true]);

      // Set again: unchanged, nothing written.
      const rows = await ownerRows(alice);
      expect([
        (await patch(alice, studyId, obs, { establishment: 'set' })).body,
        isDeepStrictEqual(await ownerRows(alice), rows),
      ]).toStrictEqual([NODE_UNCHANGED, true]);

      // An edit saves and clears the marker in the same write.
      const edited = await patch(alice, studyId, obs, { text: 'Paul appeals to his conscience' });
      expect([edited.status, (edited.body as { warnings: string[] }).warnings]).toStrictEqual([
        200,
        ['establishment_cleared'],
      ]);
      const afterEdit = await detail(alice, studyId, obs);
      expect(afterEdit).toMatchObject({
        text: 'Paul appeals to his conscience',
        establishedAt: null,
      });

      // Mark again, then remove: observation_updated with previousEstablished.
      await patch(alice, studyId, obs, { establishment: 'set' });
      const mid = (await studyOf(studyId)).lastEventSequence;
      const cleared = await patch(alice, studyId, obs, { establishment: 'clear' });
      expect(cleared.status).toBe(200);
      expect(await eventsSince(studyId, mid)).toStrictEqual([
        {
          eventType: 'observation_updated',
          payload: {
            nodeId: obs,
            observationKind: 'textual_observation',
            established: false,
            previousEstablished: true,
          },
        },
      ]);
      expect((await patch(alice, studyId, obs, { establishment: 'clear' })).body).toStrictEqual(
        NODE_UNCHANGED,
      );
      // An edit of an unmarked observation: no warning, previousEstablished false.
      const plain = await patch(alice, studyId, obs, { observationKind: 'interpretation' });
      expect((plain.body as { warnings: string[] }).warnings).toStrictEqual([]);
    });

    it('refuses the marker with an edit (400), on other node types (422), and keeps it off every type but observations and supported conclusions in SQL', async () => {
      const { studyId } = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const th = await thought(alice, studyId);
      expect(
        (await patch(alice, studyId, obs, { establishment: 'clear', text: 'New' })).body,
      ).toStrictEqual(
        invalid({ establishment: ["Mark or remove 'Established by me' separately from an edit."] }),
      );
      expect((await patch(alice, studyId, th, { establishment: 'set' })).body).toStrictEqual(
        NODE_NOT_EDITABLE,
      );
      await db.query(`UPDATE study_node SET established_at = now() WHERE id = $1`, { bind: [obs] });
      const refused = await db
        .query(`UPDATE study_node SET established_at = now() WHERE id = $1`, { bind: [th] })
        .catch((e: unknown) => e);
      expect(refused).toMatchObject({
        parent: expect.objectContaining({ constraint: 'study_node_established_check' }),
      });
    });
  });

  describe('duplicating a node (BIB-61)', () => {
    it('copies a supported, established conclusion as a tentative one with its own version 1 and no relationships; the original keeps everything', async () => {
      const { studyId } = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      await connect(alice, studyId, obs, c, 'supports');
      await establishConclusion(alice, studyId, c);
      const sourceRevision = await revisionOf(c);
      const before = await studyOf(studyId);

      const res = await send(
        alice,
        'post',
        duplicatePath(studyId, c),
        { expectedRevision: before.revision },
        DUP_KEY,
      );
      expect([res.status, res.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId,
          type: 'conclusion',
          origin: 'user',
          revision: 1,
          referenceId: null,
          createdAt: anyTime,
          updatedAt: anyTime,
          lastEventSequence: anySequence,
          versionId: anyId,
          previousVersionId: null,
          warnings: [],
          studyRevision: before.revision + 1,
          duplicateOfNodeId: c,
        },
      ]);
      const copy = res.body as { id: string; versionId: string };
      const after = await studyOf(studyId);
      expect([after.revision, after.contentRevision]).toStrictEqual([
        before.revision + 1,
        before.contentRevision + 1,
      ]);
      expect(await eventsSince(studyId, before.lastEventSequence)).toStrictEqual([
        {
          eventType: 'conclusion_created',
          payload: { nodeId: copy.id, versionId: copy.versionId, duplicateOfNodeId: c },
        },
      ]);
      expect(await detail(alice, studyId, copy.id)).toMatchObject({
        text: 'Conscience is a moral witness',
        status: 'tentative',
        establishedAt: null,
        evidenceIncomplete: false,
        liveEvidenceCount: 0,
        version: { id: copy.versionId, number: 1 },
      });
      const versions = (
        (await send(alice, 'get', `${nodePath(studyId, copy.id)}/versions`))
          .body as NodeVersionListResponse
      ).items;
      expect(
        versions.map((v) => [v.versionNumber, v.action, v.changeReason, v.evidence]),
      ).toStrictEqual([[1, 'created', null, []]]);
      const edges = await send(alice, 'get', `${edgesPath(studyId)}?nodeId=${copy.id}`);
      expect(edges.body).toStrictEqual({ items: [] });
      expect(await detail(alice, studyId, c)).toMatchObject({
        status: 'supported',
        establishedAt: expect.stringMatching(ISO),
        revision: sourceRevision,
      });

      // Replay: the same answer, one node and one event.
      const rows = await ownerRows(alice);
      const replay = await send(
        alice,
        'post',
        duplicatePath(studyId, c),
        { expectedRevision: before.revision },
        DUP_KEY,
      );
      expect([
        replay.status,
        replay.body,
        isDeepStrictEqual(await ownerRows(alice), rows),
      ]).toStrictEqual([201, res.body, true]);
      expect(
        (
          await send(
            alice,
            'post',
            duplicatePath(studyId, c),
            { expectedRevision: before.revision + 1 },
            DUP_KEY,
          )
        ).body,
      ).toStrictEqual(KEY_REUSED);
    });

    it('copies each other type’s content and origin with a fresh status, never the observation marker; a Scripture node is 422 and nothing is written', async () => {
      const { studyId } = await createStudy(alice, { question: 'What is conscience?' });
      const obs = await observation(alice, studyId);
      await patch(alice, studyId, obs, { establishment: 'set' });
      const question = await createNode(alice, studyId, { type: 'question', text: 'Why?' });
      await patch(alice, studyId, question, { status: 'answered' });
      const th = await thought(alice, studyId, 'Maybe so');
      const src = await createNode(alice, studyId, {
        type: 'source',
        source: { title: 'Commentary', kind: 'commentary', locator: 'p. 4' },
      });
      const passage = await createNode(alice, studyId, {
        type: 'scripture',
        referenceId: romans.id,
      });
      const mainBefore = (await studyOf(studyId)).mainQuestionNodeId;

      const dup = async (nodeId: string) => {
        const res = await send(alice, 'post', duplicatePath(studyId, nodeId), {
          expectedRevision: (await studyOf(studyId)).revision,
        });
        expect(res.status).toBe(201);
        return detail(alice, studyId, (res.body as { id: string }).id);
      };
      const strip = (node: NodeResponse) => {
        const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = node;
        return rest;
      };
      expect(strip(await dup(obs))).toStrictEqual({
        type: 'observation',
        studyId,
        origin: 'user',
        canonicalNodeId: null,
        revision: 1,
        text: 'Paul appeals to conscience',
        observationKind: 'textual_observation',
        establishedAt: null,
        derivedFromNote: null,
      });
      expect(await dup(question)).toMatchObject({ text: 'Why?', status: 'open' });
      expect(await dup(th)).toMatchObject({ text: 'Maybe so', origin: 'user' });
      expect(await dup(src)).toMatchObject({
        origin: 'external',
        source: { title: 'Commentary', kind: 'commentary', locator: 'p. 4', url: null },
      });
      expect((await studyOf(studyId)).mainQuestionNodeId).toBe(mainBefore);

      const rows = await ownerRows(alice);
      const refused = await send(alice, 'post', duplicatePath(studyId, passage), {
        expectedRevision: (await studyOf(studyId)).revision,
      });
      expect([refused.status, refused.body]).toStrictEqual([422, NODE_NOT_DUPLICABLE]);
      expect(isDeepStrictEqual(await ownerRows(alice), rows)).toBe(true);
    });

    it('is a study mutation: 428 without expectedRevision, 409 stale, 400 for another key, 404 for a deleted source, and 422 at the node cap', async () => {
      const { studyId } = await createStudy(alice);
      const th = await thought(alice, studyId);
      const revision = (await studyOf(studyId)).revision;
      expect((await send(alice, 'post', duplicatePath(studyId, th), {})).body).toStrictEqual(
        REVISION_MISSING,
      );
      expect(
        (await send(alice, 'post', duplicatePath(studyId, th), { expectedRevision: revision - 1 }))
          .body,
      ).toStrictEqual(conflict(revision));
      expect(
        (
          await send(alice, 'post', duplicatePath(studyId, th), {
            expectedRevision: revision,
            text: 'x',
          })
        ).status,
      ).toBe(400);

      const gone = await thought(alice, studyId, 'Gone');
      await send(alice, 'delete', deletePath(studyId, gone), {
        expectedRevision: await revisionOf(gone),
      });
      expect(
        (
          await send(alice, 'post', duplicatePath(studyId, gone), {
            expectedRevision: (await studyOf(studyId)).revision,
          })
        ).body,
      ).toStrictEqual(NOT_FOUND);

      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         SELECT $1, $2, 'thought', 'user', 'filler' FROM generate_series(1, 2000 - (
           SELECT count(*) FROM study_node WHERE study_id = $1 AND deleted_at IS NULL))`,
        { bind: [studyId, alice.user.id], type: QueryTypes.INSERT },
      );
      expect(
        (
          await send(alice, 'post', duplicatePath(studyId, th), {
            expectedRevision: (await studyOf(studyId)).revision,
          })
        ).body,
      ).toStrictEqual(NODE_LIMIT);
    });

    it('POST /v1/studies/:studyId/nodes/:nodeId/duplicate gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers((studyId, nodeId) => duplicatePath(studyId, nodeId), 'post', {
          expectedRevision: 1,
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });

  describe('deleting and restoring a node (BIB-31)', () => {
    it('deletes a node with its live relationships in one transaction, keeps notes and positions, and restores them under the same ids', async () => {
      const { studyId } = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const a = await thought(alice, studyId, 'A');
      const b = await thought(alice, studyId, 'B');
      const c = await thought(alice, studyId, 'C');
      const e1 = await connect(alice, studyId, obs, a, 'explains');
      const e2 = await connect(alice, studyId, b, obs, 'references');
      const removedEarlier = await connect(alice, studyId, obs, c, 'explains');
      await send(alice, 'delete', edgePath(studyId, removedEarlier), {
        expectedRevision: 1,
      });
      await StudyNodePosition.create({ studyId, ownerId: alice.user.id, nodeId: obs, x: 1, y: 2 });
      const note = await send(alice, 'post', `${STUDIES}/${studyId}/notes`, {
        expectedRevision: (await studyOf(studyId)).revision,
        targetNodeId: obs,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note' }] }],
        },
      });
      expect(note.status).toBe(201);
      const before = await studyOf(studyId);

      const res = await send(
        alice,
        'delete',
        deletePath(studyId, obs),
        { expectedRevision: 1 },
        randomUUID(),
      );
      expect([res.status, res.body]).toStrictEqual([
        200,
        {
          id: obs,
          studyId,
          type: 'observation',
          revision: 2,
          removedEdgeCount: 2,
          removedEdges: [
            { edgeId: e1, revision: 2 },
            { edgeId: e2, revision: 2 },
          ],
          promotedCanonicalNodeId: null,
          mainQuestionCleared: false,
          establishmentClearedNodeIds: [],
          lastEventSequence: anySequence,
        },
      ]);
      expect(await eventsSince(studyId, before.lastEventSequence)).toStrictEqual([
        {
          eventType: 'node_deleted',
          payload: {
            nodeId: obs,
            nodeType: 'observation',
            removedEdgeCount: 2,
            promotedCanonicalNodeId: null,
            mainQuestionCleared: false,
          },
        },
      ]);
      expect((await studyOf(studyId)).contentRevision).toBe(before.contentRevision + 1);
      const edgeRows = await StudyEdge.findAll({
        where: { studyId },
        attributes: ['id', 'deletedWithNodeId'],
        order: [['createdAt', 'ASC']],
        raw: true,
      });
      expect(edgeRows).toStrictEqual([
        { id: e1, deletedWithNodeId: obs },
        { id: e2, deletedWithNodeId: obs },
        { id: removedEarlier, deletedWithNodeId: null },
      ]);
      expect((await send(alice, 'get', nodePath(studyId, obs))).body).toStrictEqual(NOT_FOUND);
      const live = (await send(alice, 'get', nodesPath(studyId))).body as NodeListResponse;
      expect(live.items.map((n) => n.id)).toStrictEqual([a, b, c]);
      expect((await send(alice, 'get', `${edgesPath(studyId)}?nodeId=${a}`)).body).toStrictEqual({
        items: [],
      });
      const notes = (await send(alice, 'get', `${STUDIES}/${studyId}/notes`)).body as {
        items: { target: { deleted?: boolean } | null }[];
      };
      expect(notes.items.map((n) => n.target?.deleted)).toStrictEqual([true]);
      expect(await StudyNodePosition.count({ where: { nodeId: obs } })).toBe(1);
      const deleted = (await send(alice, 'get', `${nodesPath(studyId)}?state=deleted`))
        .body as DeletedNodeListResponse;
      expect(deleted.items.map((n) => [n.id, n.label, n.revision])).toStrictEqual([
        [obs, 'Paul appeals to conscience', 2],
      ]);
      expect(deleted.items[0]?.deletedAt).toMatch(ISO);
      expect((await send(alice, 'get', `${nodesPath(studyId)}?state=gone`)).status).toBe(400);

      // Delete again: 404. Connect to it: 404, even with a live twin inserted directly.
      expect(
        (await send(alice, 'delete', deletePath(studyId, obs), { expectedRevision: 2 })).body,
      ).toStrictEqual(NOT_FOUND);
      const mid = await studyOf(studyId);
      expect(
        (
          await send(alice, 'post', edgesPath(studyId), {
            expectedRevision: mid.revision,
            sourceNodeId: obs,
            targetNodeId: a,
            type: 'explains',
          })
        ).body,
      ).toStrictEqual(NOT_FOUND);

      const restoreBefore = await studyOf(studyId);
      const restored = await send(alice, 'post', restorePath(studyId, obs), {
        expectedRevision: 2,
      });
      expect([restored.status, restored.body]).toStrictEqual([
        200,
        {
          id: obs,
          studyId,
          type: 'observation',
          origin: 'user',
          revision: 3,
          referenceId: null,
          createdAt: anyTime,
          updatedAt: anyTime,
          lastEventSequence: anySequence,
          versionId: null,
          previousVersionId: null,
          warnings: [],
          canonicalNodeId: null,
          restoredEdgeIds: [e1, e2],
          restoredEdges: [
            { edgeId: e1, revision: 3 },
            { edgeId: e2, revision: 3 },
          ],
          skippedEdges: [],
          establishmentClearedNodeIds: [],
        },
      ]);
      expect(await eventsSince(studyId, restoreBefore.lastEventSequence)).toStrictEqual([
        {
          eventType: 'node_restored',
          payload: {
            nodeId: obs,
            nodeType: 'observation',
            restoredEdgeCount: 2,
            skippedEdgeCount: 0,
            canonicalNodeId: null,
          },
        },
      ]);
      const back = await send(alice, 'get', `${edgesPath(studyId)}?nodeId=${obs}`);
      expect(
        (back.body as { items: { id: string }[] }).items.map((e) => e.id).sort(),
      ).toStrictEqual([e1, e2].sort());
      expect(
        (await send(alice, 'post', restorePath(studyId, obs), { expectedRevision: 3 })).body,
      ).toStrictEqual(NODE_NOT_DELETED);
    });

    it('clears "Established by me" on a conclusion that lost its last evidence, keeps its status and history, and never sets it back on restore (FR-GRAPH-010)', async () => {
      const { studyId } = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      const support = await connect(alice, studyId, obs, c, 'supports');
      await establishConclusion(alice, studyId, c);
      const before = await studyOf(studyId);

      const res = await send(alice, 'delete', deletePath(studyId, obs), { expectedRevision: 1 });
      expect(res.body).toMatchObject({ removedEdgeCount: 1, establishmentClearedNodeIds: [c] });
      const events = await eventsSince(studyId, before.lastEventSequence);
      expect(events.map((e) => e.eventType)).toStrictEqual([
        'node_deleted',
        'conclusion_establishment_cleared',
      ]);
      expect(events[1]?.payload).toStrictEqual({
        nodeId: c,
        versionId: anyId,
        versionNumber: 4,
        edgeId: null,
        deletedNodeId: obs,
      });
      expect(await detail(alice, studyId, c)).toMatchObject({
        status: 'supported',
        establishedAt: null,
        evidenceIncomplete: true,
      });
      const history = (
        (await send(alice, 'get', `${nodePath(studyId, c)}/versions`))
          .body as NodeVersionListResponse
      ).items;
      expect(history.map((v) => v.action)).toStrictEqual([
        'evidence_removed',
        'established',
        'updated',
        'created',
      ]);
      expect(
        history[1]?.evidence.map((e) => [e.edgeId, e.edgeLive, e.nodeLive, e.label]),
      ).toStrictEqual([[support, false, false, 'Paul appeals to conscience']]);

      await send(alice, 'post', restorePath(studyId, obs), { expectedRevision: 2 });
      expect(await detail(alice, studyId, c)).toMatchObject({
        establishedAt: null,
        evidenceIncomplete: false,
      });
      const again = (
        (await send(alice, 'get', `${nodePath(studyId, c)}/versions`))
          .body as NodeVersionListResponse
      ).items;
      expect(again[1]?.evidence.map((e) => [e.edgeLive, e.nodeLive])).toStrictEqual([[true, true]]);
    });

    it('reports relationships it could not restore: the other end deleted (handed over and restored with it later) or an identical one already live', async () => {
      const { studyId } = await createStudy(alice);
      const x = await thought(alice, studyId, 'X');
      const y = await thought(alice, studyId, 'Y');
      const z = await thought(alice, studyId, 'Z');
      const xy = await connect(alice, studyId, x, y, 'explains');
      const xz = await connect(alice, studyId, x, z, 'references');
      await send(alice, 'delete', deletePath(studyId, x), { expectedRevision: 1 });
      await send(alice, 'delete', deletePath(studyId, y), { expectedRevision: 1 });
      // xy's other end is deleted, xz's is live.
      const restored = await send(alice, 'post', restorePath(studyId, x), { expectedRevision: 2 });
      expect(restored.body).toMatchObject({
        restoredEdgeIds: [xz],
        skippedEdges: [{ edgeId: xy, revision: 3, reason: 'endpoint_deleted' }],
      });
      const handed = await StudyEdge.findByPk(xy, { rejectOnEmpty: true });
      expect([handed.deletedAt !== null, handed.deletedWithNodeId]).toStrictEqual([true, y]);
      const yBack = await send(alice, 'post', restorePath(studyId, y), { expectedRevision: 2 });
      expect(yBack.body).toMatchObject({ restoredEdgeIds: [xy], skippedEdges: [] });

      // An identical live relationship (seeded directly: no API path makes one while an end is
      // deleted) wins over the one deleted with z.
      await send(alice, 'delete', deletePath(studyId, z), { expectedRevision: 1 });
      await StudyEdge.create({
        studyId,
        ownerId: alice.user.id,
        sourceNodeId: x,
        targetNodeId: z,
        type: 'references',
        origin: 'user',
      });
      const dupe = await send(alice, 'post', restorePath(studyId, z), { expectedRevision: 2 });
      expect(dupe.body).toMatchObject({
        restoredEdgeIds: [],
        restoredEdges: [],
        skippedEdges: [{ edgeId: xz, revision: 4, reason: 'duplicate' }],
      });
      // The skipped edge is untouched and still names z, so it stays recoverable.
      const kept = await StudyEdge.findByPk(xz, { rejectOnEmpty: true });
      expect([kept.deletedAt !== null, kept.deletedWithNodeId, kept.revision]).toStrictEqual([
        true,
        z,
        4,
      ]);
      // Once the identical one is gone, the edge restore route brings it back with the revision
      // the node restore reported.
      const twin = await StudyEdge.findOne({
        where: { studyId, deletedAt: null, sourceNodeId: x, targetNodeId: z },
        rejectOnEmpty: true,
      });
      await send(alice, 'delete', edgePath(studyId, twin.id), { expectedRevision: 1 });
      const back = await send(alice, 'post', `${edgePath(studyId, xz)}/restore`, {
        expectedRevision: 4,
      });
      expect([back.status, (back.body as { id: string }).id]).toStrictEqual([200, xz]);
    });

    it('leaves a relationship skipped at the edge cap deleted but recoverable: a later delete and restore of the node, or the edge restore route once there is room, brings it back', async () => {
      const { studyId } = await createStudy(alice);
      const x = await thought(alice, studyId, 'X');
      const y = await thought(alice, studyId, 'Y');
      const xy = await connect(alice, studyId, x, y, 'explains');
      await send(alice, 'delete', deletePath(studyId, x), { expectedRevision: 1 });
      // 80 filler nodes give 6,320 ordered pairs: fill the study to the 6,000-edge cap.
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
          LIMIT 6000`,
        { bind: [studyId, alice.user.id] },
      );

      const restored = await send(alice, 'post', restorePath(studyId, x), { expectedRevision: 2 });
      expect(restored.body).toMatchObject({
        restoredEdgeIds: [],
        restoredEdges: [],
        skippedEdges: [{ edgeId: xy, revision: 2, reason: 'limit' }],
      });
      const kept = await StudyEdge.findByPk(xy, { rejectOnEmpty: true });
      expect([kept.deletedAt !== null, kept.deletedWithNodeId]).toStrictEqual([true, x]);

      // Room frees up: deleting and restoring the node again retries the skipped edge.
      await db.query(
        `UPDATE study_edge SET deleted_at = now() WHERE id = (
           SELECT id FROM study_edge WHERE study_id = $1 AND deleted_at IS NULL LIMIT 1)`,
        { bind: [studyId] },
      );
      await send(alice, 'delete', deletePath(studyId, x), { expectedRevision: 3 });
      const again = await send(alice, 'post', restorePath(studyId, x), { expectedRevision: 4 });
      expect(again.body).toMatchObject({
        restoredEdgeIds: [xy],
        restoredEdges: [{ edgeId: xy, revision: 3 }],
        skippedEdges: [],
      });
    });

    it('promotes the oldest live duplicate when a canonical passage is deleted, and restores the old canonical as its duplicate, never two live canonicals', async () => {
      const { studyId } = await createStudy(alice);
      const canonical = await createNode(alice, studyId, {
        type: 'scripture',
        referenceId: romans.id,
      });
      const copy = () =>
        createNode(alice, studyId, {
          type: 'scripture',
          referenceId: romans.id,
          duplicatePolicy: 'explicit_duplicate',
        });
      const d1 = await copy();
      const d2 = await copy();
      const d3 = await copy();
      await send(alice, 'delete', deletePath(studyId, d3), { expectedRevision: 1 });

      const res = await send(alice, 'delete', deletePath(studyId, canonical), {
        expectedRevision: 1,
      });
      expect(res.body).toMatchObject({ promotedCanonicalNodeId: d1 });
      const rows = await StudyNode.findAll({
        where: { studyId, type: 'scripture' },
        attributes: ['id', 'canonicalNodeId'],
        raw: true,
      });
      expect(new Map(rows.map((r) => [r.id, r.canonicalNodeId]))).toStrictEqual(
        new Map([
          [canonical, null],
          [d1, null],
          [d2, d1],
          [d3, d1],
        ]),
      );
      const add = await send(alice, 'post', nodesPath(studyId), {
        expectedRevision: (await studyOf(studyId)).revision,
        type: 'scripture',
        referenceId: romans.id,
      });
      expect(add.body).toMatchObject({ id: d1, outcome: 'focused_existing' });

      const restored = await send(alice, 'post', restorePath(studyId, canonical), {
        expectedRevision: 2,
      });
      expect(restored.body).toMatchObject({ canonicalNodeId: d1 });
      const liveCanonicals = await StudyNode.count({
        where: { studyId, type: 'scripture', canonicalNodeId: null, deletedAt: null },
      });
      expect(liveCanonicals).toBe(1);
    });

    it('clears the main question on delete without touching the original, keeps the branch, and never re-points it on restore', async () => {
      const created = await createStudy(alice, { question: 'What is conscience?' });
      const { studyId } = created;
      const question = created.questionNodeId as string;
      const res = await send(alice, 'delete', deletePath(studyId, question), {
        expectedRevision: 1,
      });
      expect(res.body).toMatchObject({ mainQuestionCleared: true });
      const study = await studyOf(studyId);
      expect([study.mainQuestionNodeId, study.originalQuestionNodeId]).toStrictEqual([
        null,
        question,
      ]);
      expect(await StudyBranch.count({ where: { studyId, rootNodeId: question } })).toBe(1);
      await send(alice, 'post', restorePath(studyId, question), { expectedRevision: 2 });
      expect((await studyOf(studyId)).mainQuestionNodeId).toBeNull();
    });

    it('is a node mutation: 428 without expectedRevision, 409 stale, a replayed key returns the stored answer once, another body with the key is 422, and restore at the node cap is 422', async () => {
      const { studyId } = await createStudy(alice);
      const th = await thought(alice, studyId);
      expect((await send(alice, 'delete', deletePath(studyId, th), {})).body).toStrictEqual(
        REVISION_MISSING,
      );
      expect(
        (await send(alice, 'delete', deletePath(studyId, th), { expectedRevision: 5 })).body,
      ).toStrictEqual(conflict(1));
      const first = await send(
        alice,
        'delete',
        deletePath(studyId, th),
        { expectedRevision: 1 },
        DELETE_KEY,
      );
      const rows = await ownerRows(alice);
      const replay = await send(
        alice,
        'delete',
        deletePath(studyId, th),
        { expectedRevision: 1 },
        DELETE_KEY,
      );
      expect([replay.body, isDeepStrictEqual(await ownerRows(alice), rows)]).toStrictEqual([
        first.body,
        true,
      ]);
      expect(
        (await send(alice, 'delete', deletePath(studyId, th), { expectedRevision: 2 }, DELETE_KEY))
          .body,
      ).toStrictEqual(KEY_REUSED);
      expect(
        (await send(alice, 'post', restorePath(studyId, th), { expectedRevision: 1 })).body,
      ).toStrictEqual(conflict(2));

      await db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body)
         SELECT $1, $2, 'thought', 'user', 'filler' FROM generate_series(1, 2000)`,
        { bind: [studyId, alice.user.id], type: QueryTypes.INSERT },
      );
      expect(
        (await send(alice, 'post', restorePath(studyId, th), { expectedRevision: 2 })).body,
      ).toStrictEqual(NODE_LIMIT);
    });

    it('DELETE /v1/studies/:studyId/nodes/:nodeId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers((studyId, nodeId) => deletePath(studyId, nodeId), 'delete', {
          expectedRevision: 1,
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('POST /v1/studies/:studyId/nodes/:nodeId/restore gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers(
          (studyId, nodeId) => restorePath(studyId, nodeId),
          'post',
          { expectedRevision: 2 },
          true,
        ),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });

  /** Bob's calls on Alice's node, absent and malformed ids, and Alice's node under her other study. */
  async function crossUserAnswers(
    path: (studyId: string, nodeId: string) => string,
    method: 'post' | 'delete',
    body: object,
    deleteFirst = false,
  ) {
    const { studyId } = await createStudy(alice);
    const node = await thought(alice, studyId, 'Alice private thought');
    if (deleteFirst) {
      await send(alice, 'delete', deletePath(studyId, node), { expectedRevision: 1 });
    }
    const aliceOther = await createStudy(alice);
    const bobsStudy = await createStudy(bob);
    const aliceBefore = await ownerRows(alice);
    const bobBefore = await ownerRows(bob);
    const answers = [
      await send(bob, method, path(studyId, node), body),
      await send(bob, method, path(studyId, randomUUID()), body),
      await send(bob, method, path(studyId, 'not-a-uuid'), body),
      await send(bob, method, path(bobsStudy.studyId, node), body),
      await send(alice, method, path(aliceOther.studyId, node), body),
      await send(null, method, path(studyId, node), body),
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
});
