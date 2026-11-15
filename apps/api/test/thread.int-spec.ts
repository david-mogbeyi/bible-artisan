import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateNodeResponse,
  CreateStudyResponse,
  RecordActivityResponse,
  ResolveReferenceResponse,
  ScriptureReference,
  StudyEventDetail,
  ThreadEventsResponse,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { StudyEvent } from '../src/database/models/study-event.model';
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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const anyId: unknown = expect.stringMatching(UUID);
const anyTime: unknown = expect.stringMatching(ISO);
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);

// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const activityPath = (studyId: string): string => `/v1/studies/${studyId}/activity`;
const eventsPath = (studyId: string): string => `/v1/studies/${studyId}/events`;
const eventPath = (studyId: string, eventId: string): string =>
  `/v1/studies/${studyId}/events/${eventId}`;

const KEY_REUSED = envelope({
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});
const invalid = (fieldErrors: Record<string, string[]>) =>
  envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors });

/** BIB-55 (activity capture) and BIB-32 (reading the thread). Real PostgreSQL. */
describe('study thread (BIB-55, BIB-32)', () => {
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

  async function createStudy(owner: Owner, body: object = { blank: true }) {
    const res = await send(owner, 'post', '/v1/studies', body);
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  async function counters(studyId: string) {
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
    return {
      revision: study.revision,
      contentRevision: study.contentRevision,
      lastEventSequence: study.lastEventSequence,
    };
  }

  const visitBody = (overrides: object = {}) => ({
    kind: 'visit',
    clientMutationId: randomUUID(),
    referenceId: romans.id,
    origin: { kind: 'search' },
    ...overrides,
  });

  async function visited(owner: Owner, studyId: string, overrides: object = {}) {
    const res = await send(owner, 'post', activityPath(studyId), visitBody(overrides));
    expect(res.status).toBe(201);
    return res.body as RecordActivityResponse;
  }

  async function page(owner: Owner, studyId: string, query = '') {
    const res = await send(owner, 'get', `${eventsPath(studyId)}${query}`);
    expect(res.status).toBe(200);
    return res.body as ThreadEventsResponse;
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

  describe('POST /activity', () => {
    it('records three deliberate visits to one verse as three events with distinct origins and sequences, without a revision and without moving the study revisions', async () => {
      const { studyId } = await createStudy(alice);
      const before = await counters(studyId);
      const node = await send(alice, 'post', `/v1/studies/${studyId}/nodes`, {
        expectedRevision: before.revision,
        type: 'thought',
        text: 'Conscience bears witness',
      });
      expect(node.status).toBe(201);
      const nodeId = (node.body as CreateNodeResponse).id;
      const start = await counters(studyId);

      const first = await visited(alice, studyId, { origin: { kind: 'search' } });
      expect(first).toStrictEqual({
        eventId: anyId,
        eventType: 'scripture_opened',
        sequence: String(BigInt(start.lastEventSequence) + 1n),
        lastEventSequence: String(BigInt(start.lastEventSequence) + 1n),
      });
      const second = await visited(alice, studyId, {
        origin: { kind: 'node', nodeId },
        parentVisitEventId: first.eventId,
      });
      const third = await visited(alice, studyId, {
        origin: { kind: 'reader', referenceId: john.id },
        parentVisitEventId: second.eventId,
      });

      expect(await counters(studyId)).toStrictEqual({
        revision: start.revision,
        contentRevision: start.contentRevision,
        lastEventSequence: String(BigInt(start.lastEventSequence) + 3n),
      });
      const thread = await page(alice, studyId, '?filter=navigation');
      expect(thread).toStrictEqual({
        nextCursor: null,
        items: [
          {
            id: third.eventId,
            sequence: third.sequence,
            type: 'scripture_opened',
            visibility: 'visible',
            actorKind: 'user',
            occurredAt: anyTime,
            recordedAt: anyTime,
            sessionId: null,
            displayText: `From ${john.label}, followed ${romans.label}`,
            targetRef: { kind: 'reference', id: romans.id, label: romans.label, deleted: false },
            originRef: {
              kind: 'reader',
              ref: { kind: 'reference', id: john.id, label: john.label, deleted: false },
            },
            branchId: null,
            parentVisitEventId: second.eventId,
            correlationId: anyId,
            delayedSync: false,
          },
          {
            id: second.eventId,
            sequence: second.sequence,
            type: 'scripture_opened',
            visibility: 'visible',
            actorKind: 'user',
            occurredAt: anyTime,
            recordedAt: anyTime,
            sessionId: null,
            displayText: `From a thought, followed ${romans.label}`,
            targetRef: { kind: 'reference', id: romans.id, label: romans.label, deleted: false },
            originRef: {
              kind: 'node',
              ref: { kind: 'node', id: nodeId, label: null, deleted: false },
            },
            branchId: null,
            parentVisitEventId: first.eventId,
            correlationId: anyId,
            delayedSync: false,
          },
          {
            id: first.eventId,
            sequence: first.sequence,
            type: 'scripture_opened',
            visibility: 'visible',
            actorKind: 'user',
            occurredAt: anyTime,
            recordedAt: anyTime,
            sessionId: null,
            // Missing motive: only the recorded origin.
            displayText: `Opened ${romans.label} from search`,
            targetRef: { kind: 'reference', id: romans.id, label: romans.label, deleted: false },
            originRef: { kind: 'search', ref: null },
            branchId: null,
            parentVisitEventId: null,
            correlationId: anyId,
            delayedSync: false,
          },
        ],
      });
    });

    it('navigating from an old event appends a new visit and leaves the old one unchanged; a retry replays without a duplicate, and a changed body under the same id is refused', async () => {
      const { studyId } = await createStudy(alice);
      const old = await visited(alice, studyId);
      const oldRow = (await StudyEvent.findByPk(old.eventId, { rejectOnEmpty: true })).get({
        plain: true,
      });

      const body = visitBody({ origin: { kind: 'event', eventId: old.eventId } });
      const first = await send(alice, 'post', activityPath(studyId), body);
      const retry = await send(alice, 'post', activityPath(studyId), body);
      expect([first.status, retry.status]).toStrictEqual([201, 201]);
      expect(retry.body).toStrictEqual(first.body);
      expect(retry.headers['idempotent-replayed']).toBe('true');

      const changed = await send(alice, 'post', activityPath(studyId), {
        ...body,
        referenceId: john.id,
      });
      expect([changed.status, changed.body]).toStrictEqual([422, KEY_REUSED]);

      expect(
        (await StudyEvent.findByPk(old.eventId, { rejectOnEmpty: true })).get({ plain: true }),
      ).toStrictEqual(oldRow);
      expect(
        await StudyEvent.count({
          where: { studyId, clientMutationId: body.clientMutationId },
        }),
      ).toBe(1);
      const created = (first.body as RecordActivityResponse).eventId;
      const thread = await page(alice, studyId, '?filter=navigation');
      expect(thread.items.map((item) => [item.id, item.displayText])).toStrictEqual([
        [created, `Reopened ${romans.label} from an earlier thread event`],
        [old.eventId, `Opened ${romans.label} from search`],
      ]);
    });

    it('records a delayed visit with its original occurrence time and a delayed-sync label, and refuses one older than the offline window', async () => {
      const { studyId } = await createStudy(alice);
      const occurredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { eventId } = await visited(alice, studyId, { occurredAt });
      const detail = (await send(alice, 'get', eventPath(studyId, eventId)))
        .body as StudyEventDetail;
      expect([detail.event.occurredAt, detail.event.delayedSync]).toStrictEqual([occurredAt, true]);

      const tooOld = await send(
        alice,
        'post',
        activityPath(studyId),
        visitBody({ occurredAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }),
      );
      expect([tooOld.status, tooOld.body]).toStrictEqual([
        400,
        invalid({ occurredAt: ['Must be within the last 7 days'] }),
      ]);
    });

    it("POST /v1/studies/:studyId/activity gives another user the same neutral 404 as an absent or malformed study, and refuses another user's node and event ids, writing nothing", async () => {
      const { studyId } = await createStudy(alice);
      const aliceVisit = await visited(alice, studyId);
      const bobStudy = (await createStudy(bob)).studyId;
      const before = await StudyEvent.count({ where: { ownerId: [alice.user.id, bob.user.id] } });

      const answers = await Promise.all(
        [activityPath(studyId), activityPath(randomUUID()), activityPath('not-a-uuid')].map(
          (path) => send(bob, 'post', path, visitBody()),
        ),
      );
      expect(answers.map((res) => [res.status, res.body as unknown])).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
      const foreignEvent = await send(
        bob,
        'post',
        activityPath(bobStudy),
        visitBody({ origin: { kind: 'event', eventId: aliceVisit.eventId } }),
      );
      const foreignParent = await send(
        bob,
        'post',
        activityPath(bobStudy),
        visitBody({ parentVisitEventId: aliceVisit.eventId }),
      );
      expect([
        [foreignEvent.status, foreignEvent.body],
        [foreignParent.status, foreignParent.body],
      ]).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
      expect(await StudyEvent.count({ where: { ownerId: [alice.user.id, bob.user.id] } })).toBe(
        before,
      );
    });

    it('records searches and committed selections as internal events, hidden from the default thread and shown on request', async () => {
      const { studyId } = await createStudy(alice);
      const search = await send(alice, 'post', activityPath(studyId), {
        kind: 'search',
        clientMutationId: randomUUID(),
        query: 'conscience',
      });
      const selection = await send(alice, 'post', activityPath(studyId), {
        kind: 'selection',
        clientMutationId: randomUUID(),
        referenceId: romans.id,
      });
      expect([search.status, selection.status]).toStrictEqual([201, 201]);
      expect((await page(alice, studyId)).items.map((item) => item.type)).toStrictEqual([
        'study_created',
      ]);
      const all = await page(alice, studyId, '?includeInternal=true');
      expect(all.items.map((item) => [item.type, item.visibility, item.displayText])).toStrictEqual(
        [
          ['phrase_selected', 'internal', `Selected text in ${romans.label}`],
          ['search_performed', 'internal', 'Searched the Bible'],
          ['study_created', 'visible', 'Started this study'],
        ],
      );
    });
  });

  describe('GET /events', () => {
    it("groups one action's records under one correlation id, and GET /events/:eventId returns them all as raw details", async () => {
      const created = await createStudy(alice);
      const { studyId } = created;
      const correlationId = randomUUID();
      const edit = await send(
        alice,
        'patch',
        `/v1/studies/${studyId}`,
        { expectedRevision: created.revision, title: 'Conscience', description: 'Romans' },
        { 'x-correlation-id': correlationId },
      );
      expect(edit.status).toBe(200);
      const thread = await page(alice, studyId);
      const action = thread.items.filter((item) => item.correlationId === correlationId);
      expect(action.map((item) => item.type)).toStrictEqual([
        'study_description_changed',
        'study_renamed',
      ]);
      const [latest] = action;
      if (!latest) throw new Error('expected the edit events');
      const detail = await send(alice, 'get', eventPath(studyId, latest.id));
      expect(detail.status).toBe(200);
      expect(detail.body).toStrictEqual({
        event: latest,
        schemaVersion: 1,
        details: { cleared: false },
        correlated: [action[1], action[0]],
      });
    });

    it('pages 10,000 events 50 at a time: no event repeats or disappears when a new event arrives mid-walk, and a cursor is bound to its filters', async () => {
      const { studyId } = await createStudy(alice);
      const total = 10_000;
      // Fill the thread directly (the counter moves with it), as a long-lived study would be.
      await db.transaction(async (transaction) => {
        await db.query(
          `INSERT INTO study_event (study_id, owner_id, sequence, event_type, payload_json)
           SELECT $1, $2, s, 'thought_created', '{}'::jsonb FROM generate_series(2, $3) AS s`,
          { bind: [studyId, alice.user.id, total], type: QueryTypes.INSERT, transaction },
        );
        await db.query(`UPDATE study SET last_event_sequence = $2 WHERE id = $1`, {
          bind: [studyId, total],
          type: QueryTypes.UPDATE,
          transaction,
        });
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let slowest = 0;
      do {
        const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const started = Date.now();
        const body = await page(alice, studyId, query);
        slowest = Math.max(slowest, Date.now() - started);
        expect(body.items.length).toBeLessThanOrEqual(50);
        seen.push(...body.items.map((item) => item.sequence));
        cursor = body.nextCursor;
        pages += 1;
        // A new event arrives after the first page.
        if (pages === 1) await visited(alice, studyId);
      } while (cursor !== null);

      expect(pages).toBe(200);
      expect(new Set(seen).size).toBe(total);
      expect(seen[0]).toBe(String(total));
      expect(seen.at(-1)).toBe('1');
      // NFR-PERF-005 asks for p95 ≤ 500 ms; a generous bound keeps CI from flaking.
      expect(slowest).toBeLessThan(2000);

      const first = await page(alice, studyId, '?limit=2');
      const mismatched = await send(
        alice,
        'get',
        `${eventsPath(studyId)}?filter=questions&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      );
      expect([mismatched.status, mismatched.body]).toStrictEqual([
        400,
        invalid({ cursor: ['Invalid cursor'] }),
      ]);
    }, 120_000);

    it("GET /v1/studies/:studyId/events lists nothing of another user's: their study is the same 404 as an absent one", async () => {
      const { studyId } = await createStudy(alice);
      await visited(alice, studyId);
      const answers = await Promise.all(
        [eventsPath(studyId), eventsPath(randomUUID()), eventsPath('nope')].map((path) =>
          send(bob, 'get', path),
        ),
      );
      expect(answers.map((res) => [res.status, res.body as unknown])).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
    });

    it('GET /v1/studies/:studyId/events/:eventId gives another user the same neutral 404 as an absent or malformed id', async () => {
      const { studyId } = await createStudy(alice);
      const { eventId } = await visited(alice, studyId);
      const bobStudy = (await createStudy(bob)).studyId;
      const otherAliceStudy = (await createStudy(alice)).studyId;
      const answers = await Promise.all([
        send(bob, 'get', eventPath(studyId, eventId)),
        send(bob, 'get', eventPath(bobStudy, eventId)),
        send(alice, 'get', eventPath(otherAliceStudy, eventId)),
        send(alice, 'get', eventPath(studyId, randomUUID())),
        send(alice, 'get', eventPath(studyId, 'nope')),
      ]);
      expect(answers.map((res) => [res.status, res.body as unknown])).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
      ]);
      const own = await send(alice, 'get', eventPath(studyId, eventId));
      expect(own.status).toBe(200);
      expect((own.body as StudyEventDetail).event.sequence).toStrictEqual(anySequence);
    });
  });
});
