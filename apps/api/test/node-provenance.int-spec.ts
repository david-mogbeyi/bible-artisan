import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  CreateNodeResponse,
  CreateNoteResponse,
  CreateStudyResponse,
  NoteDocument,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { Note } from '../src/database/models/note.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
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

const nodesPath = (studyId: string): string => `/v1/studies/${studyId}/nodes`;
const nodePath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}`;
const notesPath = (studyId: string): string => `/v1/studies/${studyId}/notes`;
const notePath = (studyId: string, noteId: string): string =>
  `/v1/studies/${studyId}/notes/${noteId}`;

const NOTE_TRASHED = envelope({
  code: 'NOTE_TRASHED',
  message: 'This note is in the trash. Restore it to make changes',
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

const doc = (text: string): NoteDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** BIB-57: converting a note excerpt into an Observation or Thought. Real PostgreSQL. */
describe('note excerpt to node (BIB-57)', () => {
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
    owner: Owner,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  async function createStudy(owner: Owner): Promise<string> {
    const res = await send(owner, 'post', '/v1/studies', { blank: true });
    expect(res.status).toBe(201);
    return (res.body as CreateStudyResponse).studyId;
  }

  async function createNote(owner: Owner, studyId: string, body: object = {}) {
    const res = await send(owner, 'post', notesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      content: doc('The law written on their hearts.'),
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body as CreateNoteResponse;
  }

  async function noteRow(noteId: string) {
    const note = await Note.findByPk(noteId, { rejectOnEmpty: true });
    return { revision: note.revision, updatedAt: note.updatedAt.toISOString() };
  }

  /** Everything a refused conversion might have written for this owner. */
  async function ownerCounts(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      nodes: await StudyNode.count({ where }),
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

  it('creates an Observation and a Thought from a note: provenance on the node and its event, the note unchanged', async () => {
    const studyId = await createStudy(alice);
    const note = await createNote(alice, studyId);
    const noteBefore = await noteRow(note.id);
    const noteEventsBefore = await StudyEvent.count({
      where: { studyId, eventType: ['note_created', 'note_autosaved'] },
    });

    const observation = await send(alice, 'post', nodesPath(studyId), {
      type: 'observation',
      expectedRevision: await studyRevision(studyId),
      text: 'The law written on their hearts.',
      observationKind: 'textual_observation',
      derivedFromNoteId: note.id,
    });
    expect(observation.status).toBe(201);
    const obs = observation.body as CreateNodeResponse;
    expect(obs.outcome).toBe('created');

    const thought = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text: 'Written, not carved.',
      derivedFromNoteId: note.id,
    });
    expect(thought.status).toBe(201);
    const tht = thought.body as CreateNodeResponse;

    const obsDetail = await send(alice, 'get', nodePath(studyId, obs.id));
    expect([obsDetail.status, obsDetail.body]).toStrictEqual([
      200,
      {
        type: 'observation',
        id: obs.id,
        studyId,
        origin: 'user',
        canonicalNodeId: null,
        revision: 1,
        createdAt: anyTime,
        updatedAt: anyTime,
        text: 'The law written on their hearts.',
        observationKind: 'textual_observation',
        establishedAt: null,
        derivedFromNote: { id: note.id, trashed: false },
      },
    ]);
    const thtDetail = await send(alice, 'get', nodePath(studyId, tht.id));
    expect([thtDetail.status, thtDetail.body]).toStrictEqual([
      200,
      {
        type: 'thought',
        id: tht.id,
        studyId,
        origin: 'user',
        canonicalNodeId: null,
        revision: 1,
        createdAt: anyTime,
        updatedAt: anyTime,
        text: 'Written, not carved.',
        derivedFromNote: { id: note.id, trashed: false },
      },
    ]);

    const created = await StudyEvent.findAll({
      where: { studyId, eventType: ['observation_created', 'thought_created'] },
      order: [['sequence', 'ASC']],
    });
    expect(created.map((e) => [e.eventType, e.payloadJson])).toStrictEqual([
      [
        'observation_created',
        { nodeId: obs.id, observationKind: 'textual_observation', derivedFromNoteId: note.id },
      ],
      ['thought_created', { nodeId: tht.id, derivedFromNoteId: note.id }],
    ]);
    expect(await noteRow(note.id)).toStrictEqual(noteBefore);
    expect(
      await StudyEvent.count({
        where: { studyId, eventType: ['note_created', 'note_autosaved'] },
      }),
    ).toBe(noteEventsBefore);
  });

  it('keeps provenance through a node edit, a note edit and the note going to the trash', async () => {
    const studyId = await createStudy(alice);
    const note = await createNote(alice, studyId);
    const { body } = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text: 'First thought',
      derivedFromNoteId: note.id,
    });
    const node = body as CreateNodeResponse;

    const edited = await send(alice, 'patch', nodePath(studyId, node.id), {
      expectedRevision: 1,
      text: 'Edited thought',
    });
    expect(edited.status).toBe(200);
    const noteEdit = await send(alice, 'patch', notePath(studyId, note.id), {
      expectedRevision: note.revision,
      content: doc('Rewritten note'),
    });
    expect(noteEdit.status).toBe(200);
    const trashed = await send(alice, 'delete', notePath(studyId, note.id), {
      expectedRevision: note.revision + 1,
    });
    expect(trashed.status).toBe(200);

    const detail = await send(alice, 'get', nodePath(studyId, node.id));
    expect(detail.body).toStrictEqual(
      expect.objectContaining({
        text: 'Edited thought',
        derivedFromNote: { id: note.id, trashed: true },
      }),
    );
  });

  it('refuses a trashed note with 422 NOTE_TRASHED and converts an orphaned note', async () => {
    const studyId = await createStudy(alice);
    const target = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text: 'Target',
    });
    const targetId = (target.body as CreateNodeResponse).id;
    const orphan = await createNote(alice, studyId, { targetNodeId: targetId });
    const gone = await send(alice, 'delete', nodePath(studyId, targetId), { expectedRevision: 1 });
    expect(gone.status).toBe(200);

    const trashedNote = await createNote(alice, studyId);
    await send(alice, 'delete', notePath(studyId, trashedNote.id), {
      expectedRevision: trashedNote.revision,
    });

    const before = await ownerCounts(alice);
    const refused = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text: 'From the trash',
      derivedFromNoteId: trashedNote.id,
    });
    expect([refused.status, refused.body]).toStrictEqual([422, NOTE_TRASHED]);
    expect(await ownerCounts(alice)).toStrictEqual(before);

    const fromOrphan = await send(alice, 'post', nodesPath(studyId), {
      type: 'observation',
      expectedRevision: await studyRevision(studyId),
      text: 'Still convertible',
      observationKind: 'interpretation',
      derivedFromNoteId: orphan.id,
    });
    expect(fromOrphan.status).toBe(201);
  });

  it('refuses the field on other node types (400) and needs the study revision (428, 409)', async () => {
    const studyId = await createStudy(alice);
    const note = await createNote(alice, studyId);
    const revision = await studyRevision(studyId);
    for (const type of ['question', 'conclusion']) {
      const res = await send(alice, 'post', nodesPath(studyId), {
        type,
        expectedRevision: revision,
        text: 'Statement',
        derivedFromNoteId: note.id,
      });
      expect(res.status).toBe(400);
    }
    const missing = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      text: 'x',
      derivedFromNoteId: note.id,
    });
    expect([missing.status, missing.body]).toStrictEqual([428, REVISION_MISSING]);
    const stale = await send(alice, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: revision - 1,
      text: 'x',
      derivedFromNoteId: note.id,
    });
    expect([stale.status, stale.body]).toStrictEqual([409, conflict(revision)]);
  });

  it('replays a retried key without a second node and refuses the key with another note', async () => {
    const studyId = await createStudy(alice);
    const note = await createNote(alice, studyId);
    const other = await createNote(alice, studyId);
    const revision = await studyRevision(studyId);
    const body = {
      type: 'thought',
      expectedRevision: revision,
      text: 'Once',
      derivedFromNoteId: note.id,
    };
    const key = randomUUID();
    const first = await send(alice, 'post', nodesPath(studyId), body, key);
    const replay = await send(alice, 'post', nodesPath(studyId), body, key);
    expect(first.status).toBe(201);
    expect([replay.status, replay.body, replay.headers['idempotent-replayed']]).toStrictEqual([
      201,
      first.body,
      'true',
    ]);
    const reused = await send(
      alice,
      'post',
      nodesPath(studyId),
      { ...body, derivedFromNoteId: other.id },
      key,
    );
    expect([reused.status, reused.body]).toStrictEqual([422, KEY_REUSED]);
    expect(await StudyNode.count({ where: { studyId, derivedFromNoteId: note.id } })).toBe(1);
  });

  it("gives another user's note, another study's note and an absent note the same 404, writing nothing", async () => {
    const studyId = await createStudy(alice);
    const otherStudyId = await createStudy(alice);
    const otherStudyNote = await createNote(alice, otherStudyId);
    const bobStudyId = await createStudy(bob);
    const bobNote = await createNote(bob, bobStudyId);

    const before = await ownerCounts(alice);
    for (const noteId of [otherStudyNote.id, bobNote.id, randomUUID()]) {
      const res = await send(alice, 'post', nodesPath(studyId), {
        type: 'thought',
        expectedRevision: await studyRevision(studyId),
        text: 'Borrowed',
        derivedFromNoteId: noteId,
      });
      expect([res.status, res.body]).toStrictEqual([404, NOT_FOUND]);
    }
    expect(await ownerCounts(alice)).toStrictEqual(before);

    // And bob cannot convert into alice's study with alice's note.
    const aliceNote = await createNote(alice, studyId);
    const res = await send(bob, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text: 'Borrowed',
      derivedFromNoteId: aliceNote.id,
    });
    expect([res.status, res.body]).toStrictEqual([404, NOT_FOUND]);
  });

  it("refuses at the database another study's note (composite FK) and the column on a question (CHECK)", async () => {
    const studyId = await createStudy(alice);
    const otherStudyId = await createStudy(alice);
    const otherNote = await createNote(alice, otherStudyId);
    const ownNote = await createNote(alice, studyId);
    const insert = (type: string, noteId: string) =>
      db.query(
        `INSERT INTO study_node (study_id, owner_id, type, origin, body, title, question_status, derived_from_note_id)
         VALUES ($1, $2, $3::text, 'user',
                 CASE WHEN $3::text = 'thought' THEN 'x' END,
                 CASE WHEN $3::text = 'question' THEN 'x' END,
                 CASE WHEN $3::text = 'question' THEN 'open' END, $4)`,
        { bind: [studyId, alice.user.id, type, noteId] },
      );
    await expect(insert('thought', otherNote.id)).rejects.toMatchObject({
      parent: { constraint: 'study_node_derived_from_note_fk' },
    });
    await expect(insert('question', ownNote.id)).rejects.toMatchObject({
      parent: { constraint: 'study_node_derived_from_note_check' },
    });
  });
});
