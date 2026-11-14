import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateNodeResponse,
  CreateStudyResponse,
  ResolveReferenceResponse,
  ScriptureReference,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ReferenceService } from '../src/modules/bible-content/reference/reference.service';
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

/** The conclusion-version fields every node mutation response carries (BIB-30). */
const NO_VERSION = { versionId: null, previousVersionId: null, warnings: [] };

const STUDIES = '/v1/studies';
const nodesPath = (studyId: string): string => `/v1/studies/${studyId}/nodes`;
const nodePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}`;

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
const INVALID = envelope({
  code: 'VALIDATION',
  message: 'Invalid request',
  fieldErrors: expect.any(Object) as Record<string, string[]>,
});
const REFERENCE_NOT_FOUND = envelope({
  code: 'REFERENCE_NOT_FOUND',
  message: 'That passage is not available in an active translation',
});
const NODE_LIMIT_EXCEEDED = envelope({
  code: 'NODE_LIMIT_EXCEEDED',
  message: 'A study can hold at most 2,000 nodes',
});
const NODE_NOT_EDITABLE = envelope({
  code: 'NODE_NOT_EDITABLE',
  message: 'This node cannot be edited this way',
});
const NODE_UNCHANGED = envelope({
  code: 'NODE_UNCHANGED',
  message: 'The node already has these values',
});
const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
});
const STUDY_TRASHED = envelope({
  code: 'STUDY_TRASHED',
  message: 'This study is in the trash. Restore it to make changes',
});

const CITATION = {
  title: 'Commentary on Romans',
  kind: 'commentary',
  author: 'John Calvin',
  url: 'https://example.org/calvin/romans',
  locator: 'ch. 9',
  excerpt: 'Conscience is the witness of God.',
  excerptKind: 'paraphrase',
} as const;

/** BIB-25: the six typed graph nodes. Real PostgreSQL, whole-body assertions. */
describe('typed graph nodes (BIB-25)', () => {
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

  /** Sends one request (with an optional Idempotency-Key) and starts it immediately. */
  function send(
    owner: Owner | null,
    method: 'get' | 'post' | 'patch',
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

  async function resolve(input: string): Promise<ScriptureReference> {
    const res = await send(alice, 'post', '/v1/bible/resolve', { input, editionId });
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  /** Creates a node through the API (the study's current revision); returns its 201 body. */
  async function createNode(owner: Owner, studyId: string, body: object) {
    const res = await send(owner, 'post', nodesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      ...body,
    });
    expect([res.status, res.body]).toStrictEqual([201, expect.any(Object)]);
    return res.body as CreateNodeResponse;
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      payload: e.payloadJson,
    }));
  }

  /** Every row a node mutation of this owner may write, to prove a refusal wrote nothing. */
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
        attributes: ['id', 'type', 'revision', 'title', 'body', 'observationKind', 'payloadJson'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      branches: await StudyBranch.count({ where }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  /** Inserts `count` Thought rows straight into the table (fixtures for the node cap). */
  function insertThoughts(studyId: string, owner: Owner, count: number, deleted = false) {
    return db.query(
      `INSERT INTO study_node (study_id, owner_id, type, origin, body, deleted_at)
       SELECT $1, $2, 'thought', 'user', 'Filler', ${deleted ? 'now()' : 'NULL'}
         FROM generate_series(1, $3)`,
      { bind: [studyId, owner.user.id, count] },
    );
  }

  async function branches(studyId: string) {
    const rows = await StudyBranch.findAll({ where: { studyId }, order: [['createdAt', 'ASC']] });
    return rows.map((b) => ({ id: b.id, rootNodeId: b.rootNodeId }));
  }

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

  /** Holds the study row lock while `pending` requests queue on it, then lets them race. */
  async function raceThroughGate(studyId: string, start: () => Promise<Response>[]) {
    const gate = await db.transaction();
    await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
      bind: [studyId],
      transaction: gate,
    });
    const pending = start();
    await lockWaiters(pending.length);
    await gate.rollback();
    return Promise.all(pending);
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    editionId = edition.id;
    romans = await resolve('Romans 9:1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its nodes and events.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('create and read', () => {
    it('creates each of the six types with server-set origin and status; a fresh list and detail return exactly the stored fields', async () => {
      const study = await createStudy(alice);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const bodies = [
        { type: 'scripture', referenceId: romans.id },
        { type: 'question', text: 'What is conscience?' },
        {
          type: 'observation',
          text: '  Paul appeals to his\nconscience as a witness.  ',
          observationKind: 'textual_observation',
        },
        { type: 'thought', text: 'Maybe conscience is a second witness.' },
        { type: 'conclusion', text: 'Conscience bears witness with the Spirit.' },
        { type: 'source', source: { ...CITATION, workTitle: '  ', publicationDetails: '' } },
      ];
      const created: CreateNodeResponse[] = [];
      for (const [index, body] of bodies.entries()) {
        const res = await send(alice, 'post', nodesPath(study.studyId), {
          expectedRevision: index + 1,
          ...body,
        });
        expect([res.status, res.body]).toStrictEqual([
          201,
          {
            id: anyId,
            studyId: study.studyId,
            type: body.type,
            origin:
              body.type === 'scripture'
                ? 'scripture'
                : body.type === 'source'
                  ? 'external'
                  : 'user',
            revision: 1,
            referenceId: body.type === 'scripture' ? romans.id : null,
            createdAt: anyTime,
            updatedAt: anyTime,
            studyRevision: index + 2,
            lastEventSequence: String(index + 2),
            outcome: 'created',
            canonicalNodeId: null,
            versionId: body.type === 'conclusion' ? anyId : null,
            previousVersionId: null,
            warnings: [],
          },
        ]);
        created.push(res.body as CreateNodeResponse);
      }
      // The source URL is stored, never requested.
      expect(fetchSpy).not.toHaveBeenCalled();
      const [scripture, question, observation, thought, conclusion, source] = created.map(
        (node) => node.id,
      );
      const timesOf = (index: number) => ({
        createdAt: created[index]?.createdAt,
        updatedAt: created[index]?.updatedAt,
      });

      const list = await send(alice, 'get', nodesPath(study.studyId));
      expect([list.status, list.headers['cache-control'], list.body]).toStrictEqual([
        200,
        'no-store',
        {
          items: [
            {
              id: scripture,
              type: 'scripture',
              origin: 'scripture',
              label: 'Romans 9:1',
              status: null,
              observationKind: null,
              referenceId: romans.id,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(0),
            },
            {
              id: question,
              type: 'question',
              origin: 'user',
              label: 'What is conscience?',
              status: 'open',
              observationKind: null,
              referenceId: null,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(1),
            },
            {
              id: observation,
              type: 'observation',
              origin: 'user',
              label: 'Paul appeals to his conscience as a witness.',
              status: null,
              observationKind: 'textual_observation',
              referenceId: null,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(2),
            },
            {
              id: thought,
              type: 'thought',
              origin: 'user',
              label: 'Maybe conscience is a second witness.',
              status: null,
              observationKind: null,
              referenceId: null,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(3),
            },
            {
              id: conclusion,
              type: 'conclusion',
              origin: 'user',
              label: 'Conscience bears witness with the Spirit.',
              status: 'tentative',
              observationKind: null,
              referenceId: null,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(4),
            },
            {
              id: source,
              type: 'source',
              origin: 'external',
              label: 'Commentary on Romans',
              status: null,
              observationKind: null,
              referenceId: null,
              canonicalNodeId: null,
              established: false,
              evidenceIncomplete: false,
              revision: 1,
              ...timesOf(5),
            },
          ],
        },
      ]);

      const common = (index: number, origin: string) => ({
        id: created[index]?.id,
        studyId: study.studyId,
        origin,
        canonicalNodeId: null,
        revision: 1,
        ...timesOf(index),
      });
      const details = await Promise.all(
        created.map((node) => send(alice, 'get', nodePath(study.studyId, node.id))),
      );
      expect(details.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
        [200, { type: 'scripture', ...common(0, 'scripture'), reference: romans }],
        [
          200,
          { type: 'question', ...common(1, 'user'), text: 'What is conscience?', status: 'open' },
        ],
        [
          200,
          {
            type: 'observation',
            ...common(2, 'user'),
            text: 'Paul appeals to his\nconscience as a witness.',
            observationKind: 'textual_observation',
          },
        ],
        [
          200,
          { type: 'thought', ...common(3, 'user'), text: 'Maybe conscience is a second witness.' },
        ],
        [
          200,
          {
            type: 'conclusion',
            ...common(4, 'user'),
            text: 'Conscience bears witness with the Spirit.',
            status: 'tentative',
            establishedAt: null,
            evidenceIncomplete: false,
            liveEvidenceCount: 0,
            version: { id: anyId, number: 1 },
          },
        ],
        [
          200,
          {
            type: 'source',
            ...common(5, 'external'),
            source: { ...CITATION, workTitle: null, publicationDetails: null },
          },
        ],
      ]);
    });

    it('writes exactly one event per create with ids and enums only; the study and content revisions move by one each time', async () => {
      const study = await createStudy(alice);
      const before = await Study.findByPk(study.studyId, { rejectOnEmpty: true });
      const scripture = await createNode(alice, study.studyId, {
        type: 'scripture',
        referenceId: romans.id,
      });
      const question = await createNode(alice, study.studyId, {
        type: 'question',
        text: 'Private question',
      });
      const observation = await createNode(alice, study.studyId, {
        type: 'observation',
        text: 'Private observation',
        observationKind: 'interpretation',
      });
      const thought = await createNode(alice, study.studyId, {
        type: 'thought',
        text: 'Private thought',
      });
      const conclusion = await createNode(alice, study.studyId, {
        type: 'conclusion',
        text: 'Private conclusion',
      });
      const source = await createNode(alice, study.studyId, {
        type: 'source',
        source: { title: 'Private title', kind: 'book', locator: 'p. 9' },
      });
      const after = await Study.findByPk(study.studyId, { rejectOnEmpty: true });
      const [branch] = await branches(study.studyId);
      expect({
        revision: after.revision - before.revision,
        contentRevision: after.contentRevision - before.contentRevision,
        // The blank study's first question roots its initial branch.
        branch,
        events: await events(study.studyId),
      }).toStrictEqual({
        revision: 6,
        contentRevision: 6,
        branch: { id: anyId, rootNodeId: question.id },
        events: [
          { sequence: '1', eventType: 'study_created', payload: expect.any(Object) },
          {
            sequence: '2',
            eventType: 'scripture_added_to_graph',
            payload: { nodeId: scripture.id, referenceId: romans.id, duplicateOfNodeId: null },
          },
          {
            sequence: '3',
            eventType: 'question_created',
            payload: { questionNodeId: question.id, branchId: branch?.id },
          },
          {
            sequence: '4',
            eventType: 'observation_created',
            payload: { nodeId: observation.id, observationKind: 'interpretation' },
          },
          { sequence: '5', eventType: 'thought_created', payload: { nodeId: thought.id } },
          {
            sequence: '6',
            eventType: 'conclusion_created',
            payload: { nodeId: conclusion.id, versionId: anyId },
          },
          {
            sequence: '7',
            eventType: 'source_created',
            payload: { nodeId: source.id, sourceKind: 'book' },
          },
        ],
      });
    });

    it('refuses invalid payloads with 400, writing no node, event or receipt', async () => {
      const study = await createStudy(alice);
      const before = await ownerRows(alice);
      const bodies = [
        { type: 'thought' },
        { type: 'thought', text: 'x', observationKind: 'interpretation' },
        { type: 'question', text: 'x', status: 'answered' },
        { type: 'question', text: 'x', origin: 'external' },
        { type: 'observation', text: 'x' },
        { type: 'conclusion', text: 'x'.repeat(4001) },
        { type: 'thought', text: 'x'.repeat(10_001) },
        { type: 'thought', text: 'a\u0000b' },
        { type: 'scripture', referenceId: 'not-a-uuid' },
        { type: 'source', source: { title: 'T', kind: 'web', url: 'javascript:alert(1)' } },
        { type: 'source', source: { title: 'T', kind: 'web' } },
        { type: 'source', source: { title: 'T', kind: 'web', locator: 'p', excerpt: 'Quoted' } },
        { type: 'edge', text: 'x' },
      ];
      const answers = [];
      for (const body of bodies) {
        const res = await send(
          alice,
          'post',
          nodesPath(study.studyId),
          { expectedRevision: 1, ...body },
          randomUUID(),
        );
        answers.push([res.status, res.body]);
      }
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({ answers: bodies.map(() => [400, INVALID]), unchanged: true });
    });

    it('names the refused field without echoing the submitted text', async () => {
      const study = await createStudy(alice);
      const res = await send(alice, 'post', nodesPath(study.studyId), {
        expectedRevision: 1,
        type: 'source',
        source: { title: 'Secret title', kind: 'web', excerpt: 'Secret excerpt', locator: 'p' },
      });
      expect([res.status, res.body]).toStrictEqual([
        400,
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: {
            'source.excerptKind': ['Say whether the excerpt is a quotation or a paraphrase'],
          },
        }),
      ]);
    });

    it('needs the study revision to create (428 missing, 409 stale), replays a retried key and refuses the key with another body', async () => {
      const study = await createStudy(alice);
      const body = { expectedRevision: 1, type: 'thought', text: 'Once' };
      const missing = await send(alice, 'post', nodesPath(study.studyId), {
        type: 'thought',
        text: 'x',
      });
      const stale = await send(alice, 'post', nodesPath(study.studyId), {
        ...body,
        expectedRevision: 7,
      });
      const key = randomUUID();
      const first = await send(alice, 'post', nodesPath(study.studyId), body, key);
      const replay = await send(alice, 'post', nodesPath(study.studyId), body, key);
      const reused = await send(
        alice,
        'post',
        nodesPath(study.studyId),
        { ...body, text: 'Twice' },
        key,
      );
      expect([
        [missing.status, missing.body],
        [stale.status, stale.body],
        [first.status, replay.status, replay.headers['idempotent-replayed']],
        isDeepStrictEqual(replay.body, first.body),
        [reused.status, reused.body],
        await StudyNode.count({ where: { studyId: study.studyId } }),
      ]).toStrictEqual([
        [428, REVISION_MISSING],
        [409, conflict(1)],
        [201, 201, 'true'],
        true,
        [422, KEY_REUSED],
        1,
      ]);
    });
  });

  describe('Scripture nodes', () => {
    it('refuses an unknown reference, or one whose edition is not active, with 422 REFERENCE_NOT_FOUND, writing nothing', async () => {
      const study = await createStudy(alice);
      const before = await ownerRows(alice);
      const unknown = await send(
        alice,
        'post',
        nodesPath(study.studyId),
        { expectedRevision: 1, type: 'scripture', referenceId: randomUUID() },
        randomUUID(),
      );
      // Activated editions can never be deactivated (BIB-14 triggers): stand one in, as BIB-19 does.
      vi.spyOn(app.get(ReferenceService), 'storedReference').mockRejectedValueOnce(
        new NotFoundError(),
      );
      const inactive = await send(
        alice,
        'post',
        nodesPath(study.studyId),
        { expectedRevision: 1, type: 'scripture', referenceId: romans.id },
        randomUUID(),
      );
      expect({
        answers: [
          [unknown.status, unknown.body],
          [inactive.status, inactive.body],
        ],
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [422, REFERENCE_NOT_FOUND],
          [422, REFERENCE_NOT_FOUND],
        ],
        unchanged: true,
      });
    });
  });

  /**
   * BIB-26: one live canonical Scripture node per exact reference (FR-GRAPH-002/003). Adding it
   * again focuses it and records a visit; Explicit Duplicate makes a labeled copy.
   */
  describe('canonical Scripture nodes (BIB-26)', () => {
    const scripture = (referenceId: string, extra: object = {}) => ({
      type: 'scripture',
      referenceId,
      ...extra,
    });

    async function addScripture(
      owner: Owner,
      studyId: string,
      referenceId: string,
      extra: object = {},
      key?: string,
    ) {
      return send(
        owner,
        'post',
        nodesPath(studyId),
        { expectedRevision: await studyRevision(studyId), ...scripture(referenceId, extra) },
        key,
      );
    }

    async function counters(studyId: string) {
      const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
      return {
        revision: study.revision,
        contentRevision: study.contentRevision,
        lastActivityAt: study.lastActivityAt.getTime(),
      };
    }

    /** The study's live Scripture nodes for one reference, oldest first. */
    async function scriptureRows(studyId: string, referenceId: string) {
      const rows = await StudyNode.findAll({
        where: { studyId, type: 'scripture', scriptureReferenceId: referenceId, deletedAt: null },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      return rows.map((n) => ({
        id: n.id,
        canonicalNodeId: n.canonicalNodeId,
        revision: n.revision,
        updatedAt: n.updatedAt.toISOString(),
      }));
    }

    it('focuses the canonical node on each repeated Add: 200 focused_existing, no node written, content revision unchanged, one scripture_revisited per Add', async () => {
      const study = await createStudy(alice);
      const created = await addScripture(alice, study.studyId, romans.id);
      expect([created.status, created.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId: study.studyId,
          type: 'scripture',
          origin: 'scripture',
          revision: 1,
          referenceId: romans.id,
          createdAt: anyTime,
          updatedAt: anyTime,
          studyRevision: 2,
          lastEventSequence: '2',
          outcome: 'created',
          canonicalNodeId: null,
          ...NO_VERSION,
        },
      ]);
      const node = created.body as CreateNodeResponse;
      const rowsBefore = await scriptureRows(study.studyId, romans.id);
      const before = await counters(study.studyId);

      const again = await addScripture(alice, study.studyId, romans.id);
      const third = await addScripture(alice, study.studyId, romans.id, {
        duplicatePolicy: 'focus_existing',
      });
      const focused = (studyRevision: number, sequence: string) => [
        200,
        {
          id: node.id,
          studyId: study.studyId,
          type: 'scripture',
          origin: 'scripture',
          revision: 1,
          referenceId: romans.id,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          studyRevision,
          lastEventSequence: sequence,
          outcome: 'focused_existing',
          canonicalNodeId: null,
          ...NO_VERSION,
        },
      ];
      const after = await counters(study.studyId);
      expect({
        again: [again.status, again.body],
        third: [third.status, third.body],
        rows: await scriptureRows(study.studyId, romans.id),
        revision: after.revision - before.revision,
        contentRevision: after.contentRevision - before.contentRevision,
        activityMoved: after.lastActivityAt > before.lastActivityAt,
        events: await events(study.studyId),
      }).toStrictEqual({
        again: focused(3, '3'),
        third: focused(4, '4'),
        // The node itself is untouched: same revision and updatedAt, still the only one.
        rows: rowsBefore,
        revision: 2,
        contentRevision: 0,
        activityMoved: true,
        events: [
          { sequence: '1', eventType: 'study_created', payload: expect.any(Object) },
          {
            sequence: '2',
            eventType: 'scripture_added_to_graph',
            payload: { nodeId: node.id, referenceId: romans.id, duplicateOfNodeId: null },
          },
          {
            sequence: '3',
            eventType: 'scripture_revisited',
            payload: { nodeId: node.id, referenceId: romans.id },
          },
          {
            sequence: '4',
            eventType: 'scripture_revisited',
            payload: { nodeId: node.id, referenceId: romans.id },
          },
        ],
      });
    });

    it('creates a labeled duplicate on explicit_duplicate; later plain Adds still focus the canonical node; with no canonical node it simply creates one', async () => {
      const study = await createStudy(alice);
      const canonical = (await addScripture(alice, study.studyId, romans.id))
        .body as CreateNodeResponse;
      const before = await counters(study.studyId);
      const duplicate = await addScripture(alice, study.studyId, romans.id, {
        duplicatePolicy: 'explicit_duplicate',
      });
      expect([duplicate.status, duplicate.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId: study.studyId,
          type: 'scripture',
          origin: 'scripture',
          revision: 1,
          referenceId: romans.id,
          createdAt: anyTime,
          updatedAt: anyTime,
          studyRevision: 3,
          lastEventSequence: '3',
          outcome: 'explicit_duplicate',
          canonicalNodeId: canonical.id,
          ...NO_VERSION,
        },
      ]);
      const copy = duplicate.body as CreateNodeResponse;
      expect(copy.id).not.toBe(canonical.id);
      const afterDuplicate = await counters(study.studyId);

      const plain = await addScripture(alice, study.studyId, romans.id);
      expect([plain.status, (plain.body as CreateNodeResponse).id]).toStrictEqual([
        200,
        canonical.id,
      ]);

      const verse2 = await resolve('Romans 9:2');
      const stale = await addScripture(alice, study.studyId, verse2.id, {
        duplicatePolicy: 'explicit_duplicate',
      });
      expect([stale.status, stale.body]).toStrictEqual([
        201,
        expect.objectContaining({
          referenceId: verse2.id,
          outcome: 'created',
          canonicalNodeId: null,
        }),
      ]);
      const verse2Node = stale.body as CreateNodeResponse;

      const list = await send(alice, 'get', nodesPath(study.studyId));
      const detail = await send(alice, 'get', nodePath(study.studyId, copy.id));
      const canonicalDetail = await send(alice, 'get', nodePath(study.studyId, canonical.id));
      expect({
        contentRevision: afterDuplicate.contentRevision - before.contentRevision,
        events: (await events(study.studyId)).slice(2),
        list: (
          list.body as { items: { id: string; label: string; canonicalNodeId: unknown }[] }
        ).items.map(({ id, label, canonicalNodeId }) => ({ id, label, canonicalNodeId })),
        detail: [detail.status, detail.body],
        canonicalDetail: (canonicalDetail.body as { canonicalNodeId: unknown }).canonicalNodeId,
      }).toStrictEqual({
        contentRevision: 1,
        events: [
          {
            sequence: '3',
            eventType: 'scripture_added_to_graph',
            payload: { nodeId: copy.id, referenceId: romans.id, duplicateOfNodeId: canonical.id },
          },
          {
            sequence: '4',
            eventType: 'scripture_revisited',
            payload: { nodeId: canonical.id, referenceId: romans.id },
          },
          {
            sequence: '5',
            eventType: 'scripture_added_to_graph',
            payload: { nodeId: verse2Node.id, referenceId: verse2.id, duplicateOfNodeId: null },
          },
        ],
        list: [
          { id: canonical.id, label: 'Romans 9:1', canonicalNodeId: null },
          { id: copy.id, label: 'Romans 9:1', canonicalNodeId: canonical.id },
          { id: verse2Node.id, label: 'Romans 9:2', canonicalNodeId: null },
        ],
        detail: [
          200,
          {
            type: 'scripture',
            id: copy.id,
            studyId: study.studyId,
            origin: 'scripture',
            canonicalNodeId: canonical.id,
            revision: 1,
            createdAt: copy.createdAt,
            updatedAt: copy.updatedAt,
            reference: romans,
          },
        ],
        canonicalDetail: null,
      });
    });

    it("focuses the study's starting passage node when it is added again", async () => {
      const study = await createStudy(alice, { startingReferenceId: romans.id });
      const [root] = await scriptureRows(study.studyId, romans.id);
      const again = await addScripture(alice, study.studyId, romans.id);
      expect({
        answer: [again.status, (again.body as CreateNodeResponse).id],
        outcome: (again.body as CreateNodeResponse).outcome,
        events: (await events(study.studyId)).map((e) => e.eventType),
      }).toStrictEqual({
        answer: [200, root?.id],
        outcome: 'focused_existing',
        events: ['study_created', 'scripture_revisited'],
      });
    });

    it('deduplicates exact references only: an overlapping range is its own canonical node, and the existing node keeps its reference', async () => {
      const study = await createStudy(alice);
      const verse = (await addScripture(alice, study.studyId, romans.id))
        .body as CreateNodeResponse;
      const range = await resolve('Romans 9:1-3');
      const overlapping = await addScripture(alice, study.studyId, range.id);
      expect([overlapping.status, overlapping.body]).toStrictEqual([
        201,
        expect.objectContaining({
          referenceId: range.id,
          outcome: 'created',
          canonicalNodeId: null,
        }),
      ]);
      const detail = await send(alice, 'get', nodePath(study.studyId, verse.id));
      expect([
        (detail.body as { reference: unknown }).reference,
        await StudyNode.count({
          where: { studyId: study.studyId, type: 'scripture', canonicalNodeId: null },
        }),
      ]).toStrictEqual([romans, 2]);
    });

    it('replays a retried focused_existing Add without a second visit; the same key with another policy is refused', async () => {
      const study = await createStudy(alice);
      await addScripture(alice, study.studyId, romans.id);
      const key = randomUUID();
      const body = { expectedRevision: 2, ...scripture(romans.id) };
      const first = await send(alice, 'post', nodesPath(study.studyId), body, key);
      const replay = await send(alice, 'post', nodesPath(study.studyId), body, key);
      const reused = await send(
        alice,
        'post',
        nodesPath(study.studyId),
        { ...body, duplicatePolicy: 'explicit_duplicate' },
        key,
      );
      expect({
        statuses: [first.status, replay.status, replay.headers['idempotent-replayed']],
        sameBody: isDeepStrictEqual(replay.body, first.body),
        reused: [reused.status, reused.body],
        events: (await events(study.studyId)).map((e) => e.eventType),
        nodes: await StudyNode.count({ where: { studyId: study.studyId } }),
      }).toStrictEqual({
        statuses: [200, 200, 'true'],
        sameBody: true,
        reused: [422, KEY_REUSED],
        events: ['study_created', 'scripture_added_to_graph', 'scripture_revisited'],
        nodes: 1,
      });
    });

    it('lets two Adds of one reference from one study revision race: one 201 created, one 409, and the retry focuses the one canonical node', async () => {
      const study = await createStudy(alice);
      const body = { expectedRevision: 1, ...scripture(romans.id) };
      const results = await raceThroughGate(study.studyId, () => [
        send(alice, 'post', nodesPath(study.studyId), body),
        send(alice, 'post', nodesPath(study.studyId), body),
      ]);
      const winner = results.find((res) => res.status === 201);
      const loser = results.find((res) => res.status !== 201);
      expect([
        (winner?.body as CreateNodeResponse | undefined)?.outcome,
        [loser?.status, loser?.body],
      ]).toStrictEqual(['created', [409, conflict(2)]]);
      const retried = await send(alice, 'post', nodesPath(study.studyId), {
        ...body,
        expectedRevision: 2,
      });
      expect({
        retried: [retried.status, (retried.body as CreateNodeResponse).outcome],
        sameNode: (retried.body as CreateNodeResponse).id === (winner?.body as { id: string }).id,
        rows: (await scriptureRows(study.studyId, romans.id)).length,
      }).toStrictEqual({ retried: [200, 'focused_existing'], sameNode: true, rows: 1 });
    });

    it('still focuses at the 2,000-node cap, while an explicit duplicate is 422 NODE_LIMIT_EXCEEDED, writing nothing', async () => {
      const study = await createStudy(alice);
      await addScripture(alice, study.studyId, romans.id);
      await insertThoughts(study.studyId, alice, 1999);
      const focused = await addScripture(alice, study.studyId, romans.id);
      const before = await ownerRows(alice);
      const refused = await addScripture(
        alice,
        study.studyId,
        romans.id,
        { duplicatePolicy: 'explicit_duplicate' },
        randomUUID(),
      );
      expect({
        focused: [focused.status, (focused.body as CreateNodeResponse).outcome],
        refused: [refused.status, refused.body],
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        focused: [200, 'focused_existing'],
        refused: [422, NODE_LIMIT_EXCEEDED],
        unchanged: true,
      });
    });

    it("never focuses or duplicates another owner's node: each study has its own canonical node, and another user's study is 404 writing nothing", async () => {
      const aliceStudy = await createStudy(alice);
      const aliceNode = (await addScripture(alice, aliceStudy.studyId, romans.id))
        .body as CreateNodeResponse;
      const bobStudy = await createStudy(bob);
      const aliceBefore = await ownerRows(alice);
      const bobCreated = await addScripture(bob, bobStudy.studyId, romans.id);
      const bobAgain = await addScripture(bob, bobStudy.studyId, romans.id);
      const intoAlice = await send(bob, 'post', nodesPath(aliceStudy.studyId), {
        expectedRevision: await studyRevision(aliceStudy.studyId),
        ...scripture(romans.id, { duplicatePolicy: 'explicit_duplicate' }),
      });
      const bobNode = bobCreated.body as CreateNodeResponse;
      expect({
        bob: [bobCreated.status, bobNode.outcome, bobNode.id !== aliceNode.id],
        bobAgain: [bobAgain.status, (bobAgain.body as CreateNodeResponse).id === bobNode.id],
        intoAlice: [intoAlice.status, intoAlice.body],
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), aliceBefore),
      }).toStrictEqual({
        bob: [201, 'created', true],
        bobAgain: [200, true],
        intoAlice: [404, NOT_FOUND],
        aliceUnchanged: true,
      });
    });
  });

  describe('editing', () => {
    it('edits an observation, a thought and a source with the node revision: one event each, content revision moves, the study revision does not', async () => {
      const study = await createStudy(alice);
      const observation = await createNode(alice, study.studyId, {
        type: 'observation',
        text: 'First look',
        observationKind: 'textual_observation',
      });
      const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'Hmm' });
      const source = await createNode(alice, study.studyId, {
        type: 'source',
        source: { title: 'Old title', kind: 'web', url: 'https://example.org/old' },
      });
      const before = await Study.findByPk(study.studyId, { rejectOnEmpty: true });
      const saved = [
        await send(alice, 'patch', nodePath(study.studyId, observation.id), {
          expectedRevision: 1,
          text: 'A second look',
          observationKind: 'interpretation',
        }),
        await send(alice, 'patch', nodePath(study.studyId, observation.id), {
          expectedRevision: 2,
          observationKind: 'textual_observation',
        }),
        await send(alice, 'patch', nodePath(study.studyId, thought.id), {
          expectedRevision: 1,
          text: 'Second witness',
        }),
        await send(alice, 'patch', nodePath(study.studyId, source.id), {
          expectedRevision: 1,
          source: { title: 'New title', kind: 'article', locator: 'p. 3' },
        }),
      ];
      const after = await Study.findByPk(study.studyId, { rejectOnEmpty: true });
      const mutation = (node: CreateNodeResponse, revision: number, sequence: number) => ({
        id: node.id,
        studyId: study.studyId,
        type: node.type,
        origin: node.origin,
        revision,
        referenceId: null,
        createdAt: node.createdAt,
        updatedAt: anyTime,
        lastEventSequence: String(sequence),
        ...NO_VERSION,
      });
      expect({
        saved: saved.map((res): unknown[] => [res.status, res.body]),
        studyRevision: after.revision - before.revision,
        contentRevision: after.contentRevision - before.contentRevision,
        events: (await events(study.studyId)).slice(4),
      }).toStrictEqual({
        saved: [
          [200, mutation(observation, 2, 5)],
          [200, mutation(observation, 3, 6)],
          [200, mutation(thought, 2, 7)],
          [200, mutation(source, 2, 8)],
        ],
        studyRevision: 0,
        contentRevision: 4,
        events: [
          {
            sequence: '5',
            eventType: 'observation_updated',
            payload: { nodeId: observation.id, observationKind: 'interpretation' },
          },
          {
            sequence: '6',
            eventType: 'observation_updated',
            payload: { nodeId: observation.id, observationKind: 'textual_observation' },
          },
          { sequence: '7', eventType: 'thought_updated', payload: { nodeId: thought.id } },
          {
            sequence: '8',
            eventType: 'source_updated',
            payload: { nodeId: source.id, sourceKind: 'article' },
          },
        ],
      });
      const details = await Promise.all(
        [observation, thought, source].map((node) =>
          send(alice, 'get', nodePath(study.studyId, node.id)),
        ),
      );
      expect(
        details.map((res) => {
          const body = res.body as Record<string, unknown>;
          return body.text ?? body.observationKind ?? body.source;
        }),
      ).toStrictEqual([
        'A second look',
        'Second witness',
        {
          title: 'New title',
          kind: 'article',
          author: null,
          workTitle: null,
          publicationDetails: null,
          url: null,
          locator: 'p. 3',
          excerpt: null,
          excerptKind: null,
        },
      ]);
    });

    it('refuses a type change (400), edits of questions, conclusions and Scripture nodes or another type’s field (422 NODE_NOT_EDITABLE), and an edit that changes nothing (422 NODE_UNCHANGED), writing nothing', async () => {
      const study = await createStudy(alice, {
        startingReferenceId: romans.id,
        question: 'Main question',
      });
      const scripture = study.rootNodeId ?? '';
      const question = study.questionNodeId ?? '';
      const conclusion = await createNode(alice, study.studyId, {
        type: 'conclusion',
        text: 'C',
      });
      const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'T' });
      const observation = await createNode(alice, study.studyId, {
        type: 'observation',
        text: 'O',
        observationKind: 'interpretation',
      });
      const source = await createNode(alice, study.studyId, {
        type: 'source',
        source: { title: 'S', kind: 'web', url: 'https://example.org/s', author: 'A' },
      });
      const before = await ownerRows(alice);
      const patch = (nodeId: string, body: object) =>
        send(
          alice,
          'patch',
          nodePath(study.studyId, nodeId),
          { expectedRevision: 1, ...body },
          randomUUID(),
        );
      const answers = [
        await patch(thought.id, { type: 'observation', text: 'T2' }),
        await patch(thought.id, { origin: 'ai', text: 'T2' }),
        await patch(question, { text: 'Rewritten question' }),
        await patch(conclusion.id, { observationKind: 'interpretation' }),
        await patch(scripture, { text: 'Romans 9:2' }),
        await patch(thought.id, { observationKind: 'interpretation' }),
        await patch(observation.id, { source: { title: 'S', kind: 'web', locator: 'p' } }),
        await patch(source.id, { text: 'S2' }),
        await patch(thought.id, { text: '  T  ' }),
        await patch(observation.id, { text: 'O', observationKind: 'interpretation' }),
        // The same citation, keys reordered and an empty optional field: no change.
        await patch(source.id, {
          source: {
            author: 'A',
            url: 'https://example.org/s',
            kind: 'web',
            title: 'S',
            locator: '',
          },
        }),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [400, INVALID],
          [400, INVALID],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_NOT_EDITABLE],
          [422, NODE_UNCHANGED],
          [422, NODE_UNCHANGED],
          [422, NODE_UNCHANGED],
        ],
        unchanged: true,
      });
    });

    it('checks an edit in order: 428 missing revision, 404 absent node, then 409 stale before any rule; replays a retried key and refuses the key with another body', async () => {
      const study = await createStudy(alice, { question: 'Main question' });
      const question = study.questionNodeId ?? '';
      const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'T' });
      const key = randomUUID();
      const body = { expectedRevision: 1, text: 'T2' };
      const answers = [
        await send(alice, 'patch', nodePath(study.studyId, thought.id), { text: 'T2' }),
        await send(alice, 'patch', nodePath(study.studyId, randomUUID()), body),
        // Stale and not editable: the stale revision answers first.
        await send(alice, 'patch', nodePath(study.studyId, question), {
          expectedRevision: 5,
          text: 'x',
        }),
        await send(alice, 'patch', nodePath(study.studyId, thought.id), body, key),
        await send(alice, 'patch', nodePath(study.studyId, thought.id), body, key),
        await send(
          alice,
          'patch',
          nodePath(study.studyId, thought.id),
          { ...body, text: 'T3' },
          key,
        ),
      ];
      expect(
        answers.map((res): unknown[] => [res.status, res.headers['idempotent-replayed'] ?? null]),
      ).toStrictEqual([
        [428, null],
        [404, null],
        [409, null],
        [200, null],
        [200, 'true'],
        [422, null],
      ]);
      expect([
        answers[0]?.body,
        answers[1]?.body,
        answers[2]?.body,
        answers[5]?.body,
      ]).toStrictEqual([REVISION_MISSING, NOT_FOUND, conflict(1), KEY_REUSED]);
      expect(answers[4]?.body).toStrictEqual(answers[3]?.body);
      expect(
        (await events(study.studyId)).filter((e) => e.eventType === 'thought_updated'),
      ).toHaveLength(1);
    });

    it('serializes two edits racing from one node revision: exactly one commits, the other is 409 with the current revision', async () => {
      const study = await createStudy(alice);
      const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'T' });
      const results = await raceThroughGate(study.studyId, () => [
        send(alice, 'patch', nodePath(study.studyId, thought.id), {
          expectedRevision: 1,
          text: 'device one',
        }),
        send(alice, 'patch', nodePath(study.studyId, thought.id), {
          expectedRevision: 1,
          text: 'device two',
        }),
      ]);
      expect(results.map((res) => res.status).sort()).toStrictEqual([200, 409]);
      expect(results.find((res) => res.status === 409)?.body).toStrictEqual(conflict(2));
      const stored = await StudyNode.findByPk(thought.id, { rejectOnEmpty: true });
      expect([stored.revision, stored.body]).toStrictEqual([
        2,
        results[0]?.status === 200 ? 'device one' : 'device two',
      ]);
    });
  });

  describe('database rules', () => {
    it("refuses a direct change of a node's type, origin, reference, study or owner (trigger); content can still change", async () => {
      const study = await createStudy(alice, { startingReferenceId: romans.id });
      const other = await createStudy(alice);
      const scripture = study.rootNodeId ?? '';
      const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'T' });
      const overlapping = await resolve('Romans 9:1-3');
      const update = (sql: string, nodeId: string, value?: string) =>
        db
          .query(sql, { bind: value === undefined ? [nodeId] : [nodeId, value] })
          .then(() => 'updated')
          .catch((error: unknown) => (error as Error).message);
      const IMMUTABLE = "a study node's type, study, owner, origin and reference are immutable";
      expect([
        await update(
          `UPDATE study_node SET type = 'observation', observation_kind = 'interpretation' WHERE id = $1`,
          thought.id,
        ),
        await update(`UPDATE study_node SET origin = 'ai' WHERE id = $1`, thought.id),
        await update(
          `UPDATE study_node SET scripture_reference_id = $2 WHERE id = $1`,
          scripture,
          overlapping.id,
        ),
        await update(
          `UPDATE study_node SET study_id = $2 WHERE id = $1`,
          thought.id,
          other.studyId,
        ),
        await update(`UPDATE study_node SET owner_id = $2 WHERE id = $1`, thought.id, bob.user.id),
        await update(`UPDATE study_node SET body = 'T2' WHERE id = $1`, thought.id),
      ]).toStrictEqual([IMMUTABLE, IMMUTABLE, IMMUTABLE, IMMUTABLE, IMMUTABLE, 'updated']);
      const stored = await StudyNode.findByPk(thought.id, { rejectOnEmpty: true });
      expect([stored.type, stored.origin, stored.studyId]).toStrictEqual([
        'thought',
        'user',
        study.studyId,
      ]);
    });

    it('caps a study at 2,000 live nodes with 422 NODE_LIMIT_EXCEEDED, writing nothing; deleted nodes do not count', async () => {
      const study = await createStudy(alice);
      await insertThoughts(study.studyId, alice, 1999);
      await insertThoughts(study.studyId, alice, 5, true);
      await createNode(alice, study.studyId, { type: 'thought', text: 'Number 2,000' });
      const before = await ownerRows(alice);
      const refused = await send(
        alice,
        'post',
        nodesPath(study.studyId),
        { expectedRevision: 2, type: 'question', text: 'One too many' },
        randomUUID(),
      );
      expect({
        answer: [refused.status, refused.body],
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({ answer: [422, NODE_LIMIT_EXCEEDED], unchanged: true });
      const list = await send(alice, 'get', nodesPath(study.studyId));
      expect((list.body as { items: unknown[] }).items).toHaveLength(2000);
    });

    it("applies the same cap to a study edit's new main question: 422 NODE_LIMIT_EXCEEDED, writing nothing", async () => {
      const study = await createStudy(alice);
      await insertThoughts(study.studyId, alice, 2000);
      const before = await ownerRows(alice);
      const refused = await send(
        alice,
        'patch',
        `${STUDIES}/${study.studyId}`,
        { expectedRevision: 1, mainQuestion: { text: 'One too many' } },
        randomUUID(),
      );
      expect({
        answer: [refused.status, refused.body],
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({ answer: [422, NODE_LIMIT_EXCEEDED], unchanged: true });
    });

    it('lists every live node, newest included, even for a study over the cap from earlier data', async () => {
      const study = await createStudy(alice);
      await insertThoughts(study.studyId, alice, 2001);
      // Created after the filler rows, so it sorts last in the oldest-first list.
      const [newest] = await db.query<{ id: string }>(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body, created_at)
         VALUES ($1, $2, 'thought', 'user', 'The newest', now() + interval '1 minute')
         RETURNING id`,
        { bind: [study.studyId, alice.user.id], type: QueryTypes.SELECT },
      );
      const list = await send(alice, 'get', nodesPath(study.studyId));
      const items = (list.body as { items: { id: string; label: string }[] }).items;
      expect([list.status, items.length, items.at(-1)]).toStrictEqual([
        200,
        2002,
        expect.objectContaining({ id: newest?.id, label: 'The newest' }),
      ]);
    });
  });

  describe('initial branch', () => {
    it("roots a blank study's initial branch at its first question created through the node API; a Scripture node alone roots none, a later question none", async () => {
      const study = await createStudy(alice);
      const scripture = await createNode(alice, study.studyId, {
        type: 'scripture',
        referenceId: romans.id,
      });
      const afterScripture = await branches(study.studyId);
      const first = await createNode(alice, study.studyId, { type: 'question', text: 'First?' });
      const second = await createNode(alice, study.studyId, { type: 'question', text: 'Then?' });
      const all = await branches(study.studyId);
      expect({
        afterScripture,
        branches: all,
        events: (await events(study.studyId)).slice(1),
      }).toStrictEqual({
        afterScripture: [],
        branches: [{ id: anyId, rootNodeId: first.id }],
        events: [
          {
            sequence: '2',
            eventType: 'scripture_added_to_graph',
            payload: { nodeId: scripture.id, referenceId: romans.id, duplicateOfNodeId: null },
          },
          {
            sequence: '3',
            eventType: 'question_created',
            payload: { questionNodeId: first.id, branchId: all[0]?.id },
          },
          {
            sequence: '4',
            eventType: 'question_created',
            payload: { questionNodeId: second.id, branchId: null },
          },
        ],
      });
    });

    it('keeps the branch a passage rooted at creation: a later question creates none', async () => {
      const study = await createStudy(alice, { startingReferenceId: romans.id });
      const question = await createNode(alice, study.studyId, { type: 'question', text: 'Why?' });
      expect({
        branches: await branches(study.studyId),
        event: (await events(study.studyId)).at(-1),
      }).toStrictEqual({
        branches: [{ id: study.branchId, rootNodeId: study.rootNodeId }],
        event: {
          sequence: '2',
          eventType: 'question_created',
          payload: { questionNodeId: question.id, branchId: null },
        },
      });
    });
  });

  describe('labels', () => {
    it('lists a Scripture node whose edition is no longer active as "Passage (translation unavailable)"', async () => {
      const study = await createStudy(alice, { startingReferenceId: romans.id });
      // Activated editions can never be deactivated (BIB-14 triggers): stand one in.
      vi.spyOn(app.get(ReferenceService), 'storedReferences').mockResolvedValueOnce(new Map());
      const list = await send(alice, 'get', nodesPath(study.studyId));
      expect((list.body as { items: { label: string }[] }).items.map((n) => n.label)).toStrictEqual(
        ['Passage (translation unavailable)'],
      );
    });
  });

  describe('study lifecycle', () => {
    it('refuses node writes on an archived or trashed study with 422, writing nothing, while its nodes stay readable', async () => {
      const answersFor = async (lifecycle: 'archive' | 'trash') => {
        const study = await createStudy(alice);
        const thought = await createNode(alice, study.studyId, { type: 'thought', text: 'T' });
        const res =
          lifecycle === 'archive'
            ? await send(alice, 'post', `${STUDIES}/${study.studyId}/archive`, {
                expectedRevision: 2,
              })
            : await request(app.getHttpServer())
                .delete(`${STUDIES}/${study.studyId}`)
                .set('Cookie', alice.cookie)
                .send({ expectedRevision: 2 });
        expect(res.status).toBe(200);
        const before = await ownerRows(alice);
        const answers = [
          await send(alice, 'post', nodesPath(study.studyId), {
            expectedRevision: 3,
            type: 'thought',
            text: 'x',
          }),
          await send(alice, 'patch', nodePath(study.studyId, thought.id), {
            expectedRevision: 1,
            text: 'y',
          }),
          // BIB-26: an Add of a reference is refused too, whether it would create or focus.
          await send(alice, 'post', nodesPath(study.studyId), {
            expectedRevision: 3,
            type: 'scripture',
            referenceId: romans.id,
          }),
        ].map((r): unknown[] => [r.status, r.body]);
        const reads = [
          await send(alice, 'get', nodesPath(study.studyId)),
          await send(alice, 'get', nodePath(study.studyId, thought.id)),
        ].map((r) => r.status);
        return { answers, reads, unchanged: isDeepStrictEqual(await ownerRows(alice), before) };
      };
      expect(await answersFor('archive')).toStrictEqual({
        answers: [
          [422, STUDY_ARCHIVED],
          [422, STUDY_ARCHIVED],
          [422, STUDY_ARCHIVED],
        ],
        reads: [200, 200],
        unchanged: true,
      });
      expect(await answersFor('trash')).toStrictEqual({
        answers: [
          [422, STUDY_TRASHED],
          [422, STUDY_TRASHED],
          [422, STUDY_TRASHED],
        ],
        reads: [200, 200],
        unchanged: true,
      });
    });
  });

  describe('edit check order', () => {
    it('refuses an edit on an archived study with 422 STUDY_ARCHIVED before looking for the node: an absent node is not 404', async () => {
      const study = await createStudy(alice);
      const archived = await send(alice, 'post', `${STUDIES}/${study.studyId}/archive`, {
        expectedRevision: 1,
      });
      expect(archived.status).toBe(200);
      const before = await ownerRows(alice);
      const res = await send(alice, 'patch', nodePath(study.studyId, randomUUID()), {
        expectedRevision: 1,
        text: 'y',
      });
      expect({
        answer: [res.status, res.body],
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({ answer: [422, STUDY_ARCHIVED], unchanged: true });
    });
  });

  describe('owner isolation', () => {
    /**
     * Bob calls a node route on Alice's study and node, on an absent node, on a malformed id, on
     * Alice's node under his own study, and without a session. Returns every answer plus whether
     * either owner's rows changed, for one whole-body assertion.
     */
    async function crossUserAnswers(
      method: 'get' | 'patch',
      path: (studyId: string, nodeId: string) => string,
      body?: object,
    ) {
      const study = await createStudy(alice);
      const node = await createNode(alice, study.studyId, {
        type: 'thought',
        text: 'Alice private thought',
      });
      const aliceOther = await createStudy(alice);
      const bobsStudy = await createStudy(bob);
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const answers = [
        await send(bob, method, path(study.studyId, node.id), body),
        await send(bob, method, path(study.studyId, randomUUID()), body),
        await send(bob, method, path(study.studyId, 'not-a-uuid'), body),
        await send(bob, method, path(bobsStudy.studyId, node.id), body),
        // Alice's own node addressed under another of her studies.
        await send(alice, method, path(aliceOther.studyId, node.id), body),
        await send(null, method, path(study.studyId, node.id), body),
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

    it('POST /v1/studies/:studyId/nodes gives another user the same neutral 404 as an absent or malformed study, writing nothing', async () => {
      const study = await createStudy(alice);
      const before = await ownerRows(alice);
      const body = { expectedRevision: 1, type: 'thought', text: 'Bob was here' };
      const answers = [
        await send(bob, 'post', nodesPath(study.studyId), body),
        await send(bob, 'post', nodesPath(randomUUID()), body),
        await send(bob, 'post', nodesPath('not-a-uuid'), body),
        await send(null, 'post', nodesPath(study.studyId), body),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({
        answers,
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [401, UNAUTHENTICATED],
        ],
        aliceUnchanged: true,
      });
    });

    it("GET /v1/studies/:studyId/nodes lists nothing of another user's: their study is the same 404 as an absent one", async () => {
      const study = await createStudy(alice);
      await createNode(alice, study.studyId, { type: 'thought', text: 'Alice private thought' });
      const bobsStudy = await createStudy(bob);
      const answers = [
        await send(bob, 'get', nodesPath(study.studyId)),
        await send(bob, 'get', nodesPath(randomUUID())),
        await send(bob, 'get', nodesPath('not-a-uuid')),
        await send(bob, 'get', nodesPath(bobsStudy.studyId)),
        await send(null, 'get', nodesPath(study.studyId)),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(answers).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [200, { items: [] }],
        [401, UNAUTHENTICATED],
      ]);
    });

    it('GET /v1/studies/:studyId/nodes/:nodeId gives another user the same neutral 404 as an absent or malformed id', async () => {
      expect(
        await crossUserAnswers('get', (studyId, nodeId) => nodePath(studyId, nodeId)),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('PATCH /v1/studies/:studyId/nodes/:nodeId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('patch', (studyId, nodeId) => nodePath(studyId, nodeId), {
          expectedRevision: 1,
          text: 'Bob was here',
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });
});
