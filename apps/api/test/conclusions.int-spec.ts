import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateEdgeResponse,
  CreateNodeResponse,
  CreateStudyResponse,
  NodeMutationResponse,
  NodeResponse,
  NodeVersionListResponse,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { NodeVersion } from '../src/database/models/node-version.model';
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
const nodePath = (studyId: string, nodeId: string): string => `${nodesPath(studyId)}/${nodeId}`;
// Literal `/v1/studies/…` template: the route inventory finds a cross-user test's path through it.
const versionsPath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}/versions`;
const edgesPath = (studyId: string): string => `${STUDIES}/${studyId}/edges`;
const edgePath = (studyId: string, edgeId: string): string => `${edgesPath(studyId)}/${edgeId}`;

const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });
const NODE_UNCHANGED = envelope({
  code: 'NODE_UNCHANGED',
  message: 'The node already has these values',
});
const NODE_NOT_EDITABLE = envelope({
  code: 'NODE_NOT_EDITABLE',
  message: 'This node cannot be edited this way',
});
const EVIDENCE_REQUIRED = envelope({
  code: 'CONCLUSION_EVIDENCE_REQUIRED',
  message:
    'Connect supporting evidence first: a relationship that supports this conclusion, or one this conclusion is inferred from.',
});
const NOT_SUPPORTED = envelope({
  code: 'CONCLUSION_NOT_SUPPORTED',
  message: 'Only a supported conclusion can be marked established',
});
const REASON_REQUIRED = invalid({ changeReason: ['Say why you are making this change'] });
const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
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

/** BIB-30: question status, conclusion versions, evidence and "Established by me". */
describe('conclusion versions and explicit status actions (BIB-30)', () => {
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

  async function createStudy(owner: Owner, body: object = { blank: true }): Promise<string> {
    const res = await send(owner, 'post', STUDIES, body);
    expect(res.status).toBe(201);
    return (res.body as CreateStudyResponse).studyId;
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  async function nodeRevision(nodeId: string): Promise<number> {
    return (await StudyNode.findByPk(nodeId, { rejectOnEmpty: true })).revision;
  }

  async function createNode(owner: Owner, studyId: string, body: object): Promise<string> {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  const conclusion = (owner: Owner, studyId: string, text = 'Conscience is a moral witness') =>
    createNode(owner, studyId, { type: 'conclusion', text });
  const observation = (owner: Owner, studyId: string, text = 'Paul appeals to conscience') =>
    createNode(owner, studyId, {
      type: 'observation',
      text,
      observationKind: 'textual_observation',
    });

  async function connected(
    owner: Owner,
    studyId: string,
    sourceNodeId: string,
    targetNodeId: string,
    type: string,
  ): Promise<CreateEdgeResponse> {
    const res = await send(owner, 'post', edgesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      sourceNodeId,
      targetNodeId,
      type,
    });
    expect(res.status).toBe(201);
    return res.body as CreateEdgeResponse;
  }

  /** Patches a node at its current revision unless the body names one. */
  async function patch(
    owner: Owner,
    studyId: string,
    nodeId: string,
    body: Record<string, unknown>,
    key?: string,
  ): Promise<Response> {
    return send(
      owner,
      'patch',
      nodePath(studyId, nodeId),
      { expectedRevision: await nodeRevision(nodeId), ...body },
      key,
    );
  }

  async function patched(
    owner: Owner,
    studyId: string,
    nodeId: string,
    body: Record<string, unknown>,
  ): Promise<NodeMutationResponse> {
    const res = await patch(owner, studyId, nodeId, body);
    expect(res.status).toBe(200);
    return res.body as NodeMutationResponse;
  }

  async function detail(owner: Owner, studyId: string, nodeId: string) {
    return (await send(owner, 'get', nodePath(studyId, nodeId))).body as NodeResponse;
  }

  async function versions(owner: Owner, studyId: string, nodeId: string) {
    const res = await send(owner, 'get', versionsPath(studyId, nodeId));
    expect(res.status).toBe(200);
    return (res.body as NodeVersionListResponse).items;
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: e.payloadJson,
    }));
  }

  /** Every row a node or edge mutation of this owner may write, to prove a request wrote nothing. */
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
        attributes: [
          'id',
          'revision',
          'title',
          'conclusionStatus',
          'questionStatus',
          'establishedAt',
        ],
        order: [['id', 'ASC']],
        raw: true,
      }),
      edges: await StudyEdge.findAll({
        where,
        attributes: ['id', 'type', 'revision', 'deletedAt'],
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
  });

  afterAll(async () => {
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('question status (FR-QUESTION-001/002)', () => {
    it('changes only on the owner’s PATCH: question_status_changed with the previous status, content revision +1, any status after any; an answers edge changes nothing', async () => {
      const studyId = await createStudy(alice);
      const question = await createNode(alice, studyId, { type: 'question', text: 'Q?' });
      const before = await Study.findByPk(studyId, { rejectOnEmpty: true });

      const answered = await patch(alice, studyId, question, { status: 'answered' });
      const reopened = await patch(alice, studyId, question, { status: 'open' });
      const same = await patch(alice, studyId, question, { status: 'open' });
      const wrongKind = await patch(alice, studyId, question, { status: 'supported' });
      const text = await patch(alice, studyId, question, { text: 'Rewritten' });
      const marker = await patch(alice, studyId, question, { establishment: 'set' });

      const thoughtId = await createNode(alice, studyId, { type: 'thought', text: 'T' });
      await connected(alice, studyId, thoughtId, question, 'answers');
      const afterEdge = await detail(alice, studyId, question);
      const after = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const mutation = (revision: number, sequence: string) => ({
        id: question,
        studyId,
        type: 'question',
        origin: 'user',
        revision,
        referenceId: null,
        createdAt: anyTime,
        updatedAt: anyTime,
        lastEventSequence: sequence,
        versionId: null,
        previousVersionId: null,
        warnings: [],
      });
      expect({
        answered: [answered.status, answered.body],
        reopened: [reopened.status, reopened.body],
        same: [same.status, same.body],
        wrongKind: [wrongKind.status, wrongKind.body],
        text: [text.status, text.body],
        marker: [marker.status, marker.body],
        status: 'status' in afterEdge ? afterEdge.status : null,
        content: after.contentRevision - before.contentRevision,
        events: (await events(studyId)).filter((e) => e.eventType === 'question_status_changed'),
      }).toStrictEqual({
        answered: [200, mutation(2, expect.any(String) as string)],
        reopened: [200, mutation(3, expect.any(String) as string)],
        same: [422, NODE_UNCHANGED],
        wrongKind: [400, invalid({ status: ['This status does not belong to this kind of node'] })],
        text: [422, NODE_NOT_EDITABLE],
        marker: [422, NODE_NOT_EDITABLE],
        status: 'open',
        // Two status changes and the thought and its edge.
        content: 4,
        events: [
          {
            sequence: expect.any(String) as string,
            eventType: 'question_status_changed',
            payload: { nodeId: question, status: 'answered', previousStatus: 'open' },
          },
          {
            sequence: expect.any(String) as string,
            eventType: 'question_status_changed',
            payload: { nodeId: question, status: 'open', previousStatus: 'answered' },
          },
        ],
      });
    });
  });

  describe('conclusion versions, evidence and the marker', () => {
    it('asks for evidence before Supported (FR-CONCLUSION-002): only an incoming supports or an outgoing inference_from counts, and a refusal writes nothing', async () => {
      const studyId = await createStudy(alice);
      const target = await conclusion(alice, studyId);
      const other = await conclusion(alice, studyId, 'Another');
      const obs = await observation(alice, studyId);
      const refusedFirst = await patch(alice, studyId, target, { status: 'supported' });
      // The wrong ends: this conclusion supports something, or is the source of an inference...
      await connected(alice, studyId, target, obs, 'supports');
      await connected(alice, studyId, obs, target, 'inference_from');
      const qualifies = await connected(alice, studyId, obs, target, 'qualifies');
      const rowsBefore = await ownerRows(alice);
      const refusedWrongEnds = await patch(alice, studyId, target, { status: 'supported' });
      const markerOnTentative = await patch(alice, studyId, target, { establishment: 'set' });
      expect(isDeepStrictEqual(await ownerRows(alice), rowsBefore)).toBe(true);

      // An outgoing inference_from counts.
      await connected(alice, studyId, other, obs, 'inference_from');
      const viaInference = await patched(alice, studyId, other, { status: 'supported' });
      // So does an incoming supports.
      const supports = await connected(alice, studyId, obs, target, 'supports');
      const viaSupports = await patched(alice, studyId, target, {
        status: 'supported',
        changeReason: '  Romans 2:15  ',
      });
      const list = await versions(alice, studyId, target);
      expect({
        refusedFirst: [refusedFirst.status, refusedFirst.body],
        refusedWrongEnds: [refusedWrongEnds.status, refusedWrongEnds.body],
        markerOnTentative: [markerOnTentative.status, markerOnTentative.body],
        inferenceVersion: viaInference.versionId,
        supportsVersion: viaSupports.previousVersionId === list[1]?.id,
        list,
      }).toStrictEqual({
        refusedFirst: [422, EVIDENCE_REQUIRED],
        refusedWrongEnds: [422, EVIDENCE_REQUIRED],
        markerOnTentative: [422, NOT_SUPPORTED],
        inferenceVersion: anyId,
        supportsVersion: true,
        list: [
          {
            id: viaSupports.versionId,
            versionNumber: 2,
            action: 'updated',
            statement: 'Conscience is a moral witness',
            status: 'supported',
            established: false,
            changeReason: 'Romans 2:15',
            createdAt: anyTime,
            evidence: [
              {
                edgeId: supports.id,
                edgeType: 'supports',
                role: 'supporting',
                nodeId: obs,
                nodeType: 'observation',
                label: 'Paul appeals to conscience',
                nodeRevision: 1,
                nodeVersionId: null,
                edgeLive: true,
                nodeLive: true,
                nodeChangedSince: false,
              },
              // The qualifies edge is recorded as challenging evidence; neither the outgoing
              // supports nor the incoming inference_from is evidence for this conclusion.
              {
                edgeId: qualifies.id,
                edgeType: 'qualifies',
                role: 'challenging',
                nodeId: obs,
                nodeType: 'observation',
                label: 'Paul appeals to conscience',
                nodeRevision: 1,
                nodeVersionId: null,
                edgeLive: true,
                nodeLive: true,
                nodeChangedSince: false,
              },
            ],
          },
          {
            id: expect.any(String) as string,
            versionNumber: 1,
            action: 'created',
            statement: 'Conscience is a moral witness',
            status: 'tentative',
            established: false,
            changeReason: null,
            createdAt: anyTime,
            evidence: [],
          },
        ],
      });
    });

    it('establishes, clears the marker on revise or challenge with a warning, keeps every earlier version intact, and needs an explicit reaffirm (FR-CONCLUSION-001/003/004)', async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      const edge = await connected(alice, studyId, obs, c, 'supports');
      const supported = await patched(alice, studyId, c, {
        status: 'supported',
        establishment: 'set',
      });
      const established = await detail(alice, studyId, c);
      const sameAgain = await patch(alice, studyId, c, {
        status: 'supported',
        establishment: 'set',
      });
      const revisedNoReason = await patch(alice, studyId, c, { text: 'It can be wrong' });
      const revised = await patched(alice, studyId, c, {
        text: '  It is a moral witness that can be wrong  ',
        changeReason: '1 Cor 8:7',
      });
      const afterRevise = await detail(alice, studyId, c);
      const reaffirmed = await patched(alice, studyId, c, {
        status: 'supported',
        establishment: 'set',
      });
      const challenged = await patched(alice, studyId, c, { status: 'challenged' });
      const afterChallenge = await detail(alice, studyId, c);
      const history = await versions(alice, studyId, c);
      const evidence = (versionId: string | null) =>
        history.find((v) => v.id === versionId)?.evidence.map((e) => e.edgeId);

      expect({
        supportedEvent: supported.versionId !== null,
        established: {
          at: 'establishedAt' in established ? typeof established.establishedAt : null,
          incomplete: 'evidenceIncomplete' in established && established.evidenceIncomplete,
          live: 'liveEvidenceCount' in established ? established.liveEvidenceCount : null,
        },
        sameAgain: [sameAgain.status, sameAgain.body],
        revisedNoReason: [revisedNoReason.status, revisedNoReason.body],
        revised: {
          warnings: revised.warnings,
          previous: revised.previousVersionId === supported.versionId,
        },
        afterRevise: {
          status: 'status' in afterRevise ? afterRevise.status : null,
          text: 'text' in afterRevise ? afterRevise.text : null,
          at: 'establishedAt' in afterRevise ? afterRevise.establishedAt : 'x',
        },
        reaffirmed: reaffirmed.warnings,
        challenged: challenged.warnings,
        afterChallenge: 'establishedAt' in afterChallenge ? afterChallenge.establishedAt : 'x',
        steps: history.map((v) => [
          v.versionNumber,
          v.action,
          v.status,
          v.established,
          v.changeReason,
        ]),
        supportedEvidence: evidence(supported.versionId),
        revisedEvidence: evidence(revised.versionId),
        events: (await events(studyId))
          .filter((e) => e.eventType.startsWith('conclusion_'))
          .map((e) => [e.eventType, e.payload]),
      }).toStrictEqual({
        supportedEvent: true,
        established: { at: 'string', incomplete: false, live: 1 },
        sameAgain: [422, NODE_UNCHANGED],
        revisedNoReason: [400, REASON_REQUIRED],
        revised: { warnings: ['establishment_cleared'], previous: true },
        afterRevise: {
          status: 'revised',
          text: 'It is a moral witness that can be wrong',
          at: null,
        },
        reaffirmed: [],
        challenged: ['establishment_cleared'],
        afterChallenge: null,
        steps: [
          [5, 'challenged', 'challenged', false, null],
          [4, 'established', 'supported', true, null],
          [3, 'revised', 'revised', false, '1 Cor 8:7'],
          [2, 'established', 'supported', true, null],
          [1, 'created', 'tentative', false, null],
        ],
        supportedEvidence: [edge.id],
        revisedEvidence: [edge.id],
        events: [
          ['conclusion_created', { nodeId: c, versionId: anyId }],
          [
            'conclusion_established',
            {
              nodeId: c,
              versionId: supported.versionId,
              versionNumber: 2,
              status: 'supported',
              previousStatus: 'tentative',
              established: true,
              previousEstablished: false,
              statementChanged: false,
            },
          ],
          [
            'conclusion_updated',
            {
              nodeId: c,
              versionId: revised.versionId,
              versionNumber: 3,
              status: 'revised',
              previousStatus: 'supported',
              established: false,
              previousEstablished: true,
              statementChanged: true,
            },
          ],
          [
            'conclusion_established',
            {
              nodeId: c,
              versionId: reaffirmed.versionId,
              versionNumber: 4,
              status: 'supported',
              previousStatus: 'revised',
              established: true,
              previousEstablished: false,
              statementChanged: false,
            },
          ],
          [
            'conclusion_challenged',
            {
              nodeId: c,
              versionId: challenged.versionId,
              versionNumber: 5,
              status: 'challenged',
              previousStatus: 'supported',
              established: false,
              previousEstablished: true,
              statementChanged: false,
            },
          ],
        ],
      });
    });

    it('abandons with a reason and keeps every version and its evidence readable; the snapshot stays as written when relationships and nodes change (FR-CONCLUSION-005)', async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      const edge = await connected(alice, studyId, obs, c, 'supports');
      const v2 = await patched(alice, studyId, c, { status: 'supported' });
      const noReason = await patch(alice, studyId, c, { status: 'abandoned' });
      const blank = await patch(alice, studyId, c, { status: 'abandoned', changeReason: '   ' });
      // The relationship is retyped and the evidence node is edited after version 2.
      const retyped = await send(alice, 'patch', edgePath(studyId, edge.id), {
        expectedRevision: 1,
        type: 'explains',
      });
      const obsEdited = await send(alice, 'patch', nodePath(studyId, obs), {
        expectedRevision: 1,
        text: 'Paul appeals to his conscience twice',
      });
      const abandoned = await patched(alice, studyId, c, {
        status: 'abandoned',
        changeReason: 'Superseded',
      });
      const stored = await detail(alice, studyId, c);
      const history = await versions(alice, studyId, c);
      expect({
        noReason: [noReason.status, noReason.body],
        blank: [blank.status, blank.body],
        retyped: [
          retyped.status,
          (retyped.body as { establishmentClearedNodeIds: string[] }).establishmentClearedNodeIds,
        ],
        obsEdited: obsEdited.status,
        abandonedEvent: (await events(studyId)).at(-1)?.eventType,
        status: 'status' in stored ? stored.status : null,
        history: history.map((v) => ({
          n: v.versionNumber,
          action: v.action,
          status: v.status,
          reason: v.changeReason,
          evidence: v.evidence.map((e) => ({
            edgeType: e.edgeType,
            edgeLive: e.edgeLive,
            changed: e.nodeChangedSince,
            label: e.label,
          })),
        })),
        previous: abandoned.previousVersionId === v2.versionId,
      }).toStrictEqual({
        noReason: [400, invalid({ changeReason: ['Say why you are making this change'] })],
        blank: [400, invalid({ changeReason: ['Say why you are making this change'] })],
        retyped: [200, []],
        obsEdited: 200,
        abandonedEvent: 'conclusion_abandoned',
        status: 'abandoned',
        history: [
          {
            n: 3,
            action: 'abandoned',
            status: 'abandoned',
            reason: 'Superseded',
            evidence: [],
          },
          {
            n: 2,
            action: 'updated',
            status: 'supported',
            reason: null,
            evidence: [
              {
                // Still as written: a supports edge, though it is an explains edge now.
                edgeType: 'supports',
                edgeLive: false,
                changed: true,
                label: 'Paul appeals to his conscience twice',
              },
            ],
          },
          { n: 1, action: 'created', status: 'tentative', reason: null, evidence: [] },
        ],
        previous: true,
      });
    });

    it('clears the marker, keeps the status and writes an evidence_removed version when the last supporting relationship is removed or retyped; a second supporter or a non-established conclusion changes nothing', async () => {
      const studyId = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const spare = await observation(alice, studyId, 'A second observation');
      async function establishedConclusion(text: string) {
        const c = await conclusion(alice, studyId, text);
        const edge = await connected(alice, studyId, obs, c, 'supports');
        await patched(alice, studyId, c, { status: 'supported', establishment: 'set' });
        return { c, edge };
      }
      const removedCase = await establishedConclusion('Removed case');
      const retypedCase = await establishedConclusion('Retyped case');
      const twoCase = await establishedConclusion('Two supporters');
      const second = await connected(alice, studyId, spare, twoCase.c, 'supports');
      const plain = await conclusion(alice, studyId, 'Supported, not established');
      const plainEdge = await connected(alice, studyId, obs, plain, 'supports');
      await patched(alice, studyId, plain, { status: 'supported' });
      const plainVersions = (await versions(alice, studyId, plain)).length;

      const removeBody = (edgeRevision: number) => ({ expectedRevision: edgeRevision });
      const staleRevision = await nodeRevision(removedCase.c);
      const removed = await send(
        alice,
        'delete',
        edgePath(studyId, removedCase.edge.id),
        removeBody(1),
      );
      const retyped = await send(alice, 'patch', edgePath(studyId, retypedCase.edge.id), {
        expectedRevision: 1,
        type: 'qualifies',
      });
      const notedOnly = await send(alice, 'patch', edgePath(studyId, twoCase.edge.id), {
        expectedRevision: 1,
        note: 'still counts',
      });
      const dropOne = await send(
        alice,
        'delete',
        edgePath(studyId, twoCase.edge.id),
        removeBody(2),
      );
      const plainRemoved = await send(
        alice,
        'delete',
        edgePath(studyId, plainEdge.id),
        removeBody(1),
      );
      const stale = await send(alice, 'patch', nodePath(studyId, removedCase.c), {
        expectedRevision: staleRevision,
        status: 'challenged',
      });
      const after = async (id: string) => {
        const node = await detail(alice, studyId, id);
        return 'establishedAt' in node
          ? [node.status, node.establishedAt, node.evidenceIncomplete, node.liveEvidenceCount]
          : null;
      };
      const lastVersions = async (id: string) =>
        (await versions(alice, studyId, id))
          .slice(0, 1)
          .map((v) => [v.action, v.status, v.established, v.evidence.length]);
      const cleared = (res: Response) =>
        (res.body as { establishmentClearedNodeIds: string[] }).establishmentClearedNodeIds;
      // The response names the last event of the transaction: the cleared one, after edge_removed.
      const clearedEvents = (await events(studyId)).filter(
        (e) => e.eventType === 'conclusion_establishment_cleared',
      );
      expect((removed.body as { lastEventSequence: string }).lastEventSequence).toBe(
        String(
          Math.max(
            ...clearedEvents
              .filter((e) => (e.payload as { edgeId?: string }).edgeId === removedCase.edge.id)
              .map((e) => Number(e.sequence)),
          ),
        ),
      );
      expect({
        removed: [removed.status, cleared(removed)],
        retyped: [retyped.status, cleared(retyped)],
        notedOnly: cleared(notedOnly),
        dropOne: cleared(dropOne),
        plainRemoved: cleared(plainRemoved),
        stale: [stale.status, stale.body],
        removedNode: await after(removedCase.c),
        removedVersion: await lastVersions(removedCase.c),
        retypedNode: await after(retypedCase.c),
        twoNode: await after(twoCase.c),
        twoVersion: await lastVersions(twoCase.c),
        plainNode: await after(plain),
        plainVersions: (await versions(alice, studyId, plain)).length - plainVersions,
        clearedEvents: (await events(studyId))
          .filter((e) => e.eventType === 'conclusion_establishment_cleared')
          .map((e) => e.payload),
        secondStillLive: (await StudyEdge.findByPk(second.id, { rejectOnEmpty: true })).deletedAt,
      }).toStrictEqual({
        removed: [200, [removedCase.c]],
        retyped: [200, [retypedCase.c]],
        notedOnly: [],
        dropOne: [],
        plainRemoved: [],
        stale: [409, conflict(staleRevision + 1)],
        removedNode: ['supported', null, true, 0],
        removedVersion: [['evidence_removed', 'supported', false, 0]],
        retypedNode: ['supported', null, true, 0],
        twoNode: ['supported', expect.any(String) as string, false, 1],
        twoVersion: [['established', 'supported', true, 1]],
        plainNode: ['supported', null, true, 0],
        plainVersions: 0,
        clearedEvents: [
          {
            nodeId: removedCase.c,
            versionId: anyId,
            versionNumber: 3,
            edgeId: removedCase.edge.id,
          },
          {
            nodeId: retypedCase.c,
            versionId: anyId,
            versionNumber: 3,
            edgeId: retypedCase.edge.id,
          },
        ],
        secondStillLive: null,
      });

      // Re-adding support alone never restores the marker or changes the status.
      await connected(alice, studyId, spare, removedCase.c, 'supports');
      expect(await after(removedCase.c)).toStrictEqual(['supported', null, false, 1]);
      const reaffirmed = await patched(alice, studyId, removedCase.c, { establishment: 'set' });
      expect(reaffirmed.warnings).toStrictEqual([]);
      expect((await after(removedCase.c))?.[1]).toStrictEqual(expect.any(String));
    });

    it('keeps origin independent of the marker: an AI-origin conclusion is established by the owner and stays ai', async () => {
      const studyId = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const id = randomUUID();
      await db.query(
        `INSERT INTO study_node (id, study_id, owner_id, type, origin, title, conclusion_status)
         VALUES ($1, $2, $3, 'conclusion', 'ai', 'AI conclusion', 'tentative')`,
        { bind: [id, studyId, alice.user.id] },
      );
      await db.query(
        `INSERT INTO node_version (node_id, study_id, owner_id, version_number, action, statement,
                                   conclusion_status, established)
         VALUES ($1, $2, $3, 1, 'created', 'AI conclusion', 'tentative', false)`,
        { bind: [id, studyId, alice.user.id] },
      );
      await connected(alice, studyId, obs, id, 'supports');
      await patched(alice, studyId, id, { status: 'supported', establishment: 'set' });
      const node = await detail(alice, studyId, id);
      expect([node.origin, 'establishedAt' in node && node.establishedAt !== null]).toStrictEqual([
        'ai',
        true,
      ]);
    });

    it('shows the marker and the warning in the node list, and refuses fields of another type or an over-long statement', async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      await connected(alice, studyId, obs, c, 'supports');
      await patched(alice, studyId, c, { status: 'supported', establishment: 'set' });
      const incomplete = await conclusion(alice, studyId, 'Incomplete');
      await db.query(`UPDATE study_node SET conclusion_status = 'supported' WHERE id = $1`, {
        bind: [incomplete],
      });
      const list = (await send(alice, 'get', nodesPath(studyId))).body as {
        items: { id: string; established: boolean; evidenceIncomplete: boolean }[];
      };
      const flags = (id: string) => {
        const item = list.items.find((i) => i.id === id);
        return [item?.established, item?.evidenceIncomplete];
      };
      const rows = await ownerRows(alice);
      const answers = [
        await patch(alice, studyId, c, { observationKind: 'interpretation' }),
        await patch(alice, studyId, obs, { status: 'supported' }),
        await patch(alice, studyId, obs, { establishment: 'set' }),
        await patch(alice, studyId, obs, { changeReason: 'why', text: 'x' }),
        await patch(alice, studyId, c, { text: 'x'.repeat(4001), changeReason: 'r' }),
        await patch(alice, studyId, c, { status: 'revised' }),
        await patch(alice, studyId, c, { text: 'x', status: 'challenged', changeReason: 'r' }),
        await patch(alice, studyId, c, { establishment: 'set', status: 'challenged' }),
        await patch(alice, studyId, c, { changeReason: 'only a reason' }),
        await patch(alice, studyId, c, { origin: 'user', status: 'challenged' }),
        await patch(alice, studyId, c, { versionNumber: 3, status: 'challenged' }),
        await patch(alice, studyId, c, { evidenceEdgeIds: [randomUUID()], status: 'challenged' }),
        await patch(alice, studyId, c, { status: 'answered' }),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({ c: flags(c), incomplete: flags(incomplete), obs: flags(obs) }).toStrictEqual({
        c: [true, false],
        incomplete: [false, true],
        obs: [false, false],
      });
      expect(answers.map((answer) => answer[0])).toStrictEqual([
        422, 422, 422, 422, 400, 400, 400, 400, 400, 400, 400, 400, 400,
      ]);
      expect(answers[4]?.[1]).toStrictEqual(invalid({ text: ['Use at most 4,000 characters'] }));
      expect(isDeepStrictEqual(await ownerRows(alice), rows)).toBe(true);
    });

    it('is a study mutation: 428 without expectedRevision, 409 stale, a replayed key returns the stored answer with one version and one event, another body with the key is 422, and an archived study is 422 while its versions stay readable', async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const obs = await observation(alice, studyId);
      await connected(alice, studyId, obs, c, 'supports');
      const key = randomUUID();
      const body = { expectedRevision: 1, status: 'challenged' };
      const answers = [
        await send(alice, 'patch', nodePath(studyId, c), { status: 'challenged' }),
        await send(alice, 'patch', nodePath(studyId, c), { ...body, expectedRevision: 9 }),
        await send(alice, 'patch', nodePath(studyId, c), body, key),
        await send(alice, 'patch', nodePath(studyId, c), body, key),
        await send(alice, 'patch', nodePath(studyId, c), { ...body, status: 'tentative' }, key),
      ];
      expect(
        answers.map((res): unknown[] => [res.status, res.headers['idempotent-replayed'] ?? null]),
      ).toStrictEqual([
        [428, null],
        [409, null],
        [200, null],
        [200, 'true'],
        [422, null],
      ]);
      expect([answers[0]?.body, answers[1]?.body, answers[4]?.body]).toStrictEqual([
        REVISION_MISSING,
        conflict(1),
        KEY_REUSED,
      ]);
      expect(answers[3]?.body).toStrictEqual(answers[2]?.body);
      expect(await versions(alice, studyId, c)).toHaveLength(2);
      expect(
        (await events(studyId)).filter((e) => e.eventType === 'conclusion_challenged'),
      ).toHaveLength(1);

      const archived = await send(alice, 'post', `${STUDIES}/${studyId}/archive`, {
        expectedRevision: await studyRevision(studyId),
      });
      expect(archived.status).toBe(200);
      const refused = await patch(alice, studyId, c, { status: 'tentative' });
      expect([refused.status, refused.body]).toStrictEqual([422, STUDY_ARCHIVED]);
      expect(await versions(alice, studyId, c)).toHaveLength(2);
    });

    it('lists no versions for a node that is not a conclusion', async () => {
      const studyId = await createStudy(alice);
      const obs = await observation(alice, studyId);
      const res = await send(alice, 'get', versionsPath(studyId, obs));
      expect([res.status, res.headers['cache-control'], res.body]).toStrictEqual([
        200,
        'no-store',
        { items: [] },
      ]);
    });
  });

  describe('owner isolation', () => {
    it('GET /v1/studies/:studyId/nodes/:nodeId/versions gives another user the same neutral 404 as an absent or malformed id', async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId, 'Alice private conclusion');
      const aliceOther = await createStudy(alice);
      const bobsStudy = await createStudy(bob);
      const answers = [
        await send(bob, 'get', versionsPath(studyId, c)),
        await send(bob, 'get', versionsPath(studyId, randomUUID())),
        await send(bob, 'get', versionsPath(studyId, 'not-a-uuid')),
        await send(bob, 'get', versionsPath(bobsStudy, c)),
        await send(alice, 'get', versionsPath(aliceOther, c)),
        await send(null, 'get', versionsPath(studyId, c)),
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

    it("refuses Bob's conclusion action on Alice's conclusion and writes nothing", async () => {
      const studyId = await createStudy(alice);
      const c = await conclusion(alice, studyId);
      const before = await ownerRows(alice);
      const res = await send(bob, 'patch', nodePath(studyId, c), {
        expectedRevision: 1,
        status: 'challenged',
      });
      expect([res.status, res.body]).toStrictEqual([404, NOT_FOUND]);
      expect(isDeepStrictEqual(await ownerRows(alice), before)).toBe(true);
    });
  });
});
