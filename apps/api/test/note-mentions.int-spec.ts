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
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope } from './support/envelopes';

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

const MENTION_INVALID = envelope({
  code: 'NOTE_MENTION_INVALID',
  message: 'A node mentioned in this note is not part of this study',
});

/** A paragraph of text followed by mentions. */
const withMentions = (text: string, ...mentions: { nodeId: string; label: string }[]) =>
  ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text },
          ...mentions.map((attrs) => ({ type: 'nodeMention', attrs })),
        ],
      },
    ],
  }) as NoteDocument;

/** BIB-58: node mentions inside notes. Real PostgreSQL. */
describe('node mentions in notes (BIB-58)', () => {
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
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path).set('Cookie', owner.cookie);
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

  async function createThought(owner: Owner, studyId: string, text: string) {
    const res = await send(owner, 'post', nodesPath(studyId), {
      type: 'thought',
      expectedRevision: await studyRevision(studyId),
      text,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  async function postNote(owner: Owner, studyId: string, content: NoteDocument) {
    return send(owner, 'post', notesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      content,
    });
  }

  async function ownerCounts(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      notes: await Note.count({ where }),
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

  it('saves a mention of a live node with its label; the plain text carries the label and the note reads back whole', async () => {
    const studyId = await createStudy(alice);
    const nodeId = await createThought(alice, studyId, 'A second   witness');
    const content = withMentions('See ', { nodeId, label: 'A second witness' });
    const created = await postNote(alice, studyId, content);
    expect(created.status).toBe(201);
    const note = created.body as CreateNoteResponse;

    const read = await send(alice, 'get', notePath(studyId, note.id));
    expect([read.status, read.body]).toStrictEqual([
      200,
      {
        id: note.id,
        studyId,
        revision: 1,
        target: null,
        targetAnchor: null,
        content,
        characterCount: [...'See A second witness'].length,
        latestVersionNumber: 1,
        createdAt: anyTime,
        updatedAt: anyTime,
        deletedAt: null,
        deletedMentionNodeIds: [],
      },
    ]);
    const row = await Note.findByPk(note.id, { rejectOnEmpty: true });
    expect(row.plainText).toBe('See A second witness');
  });

  it("refuses a mention with another label, of another study's, another user's, a deleted or an absent node with 422, writing nothing", async () => {
    const studyId = await createStudy(alice);
    const nodeId = await createThought(alice, studyId, 'Mine');
    const otherStudyId = await createStudy(alice);
    const otherStudyNode = await createThought(alice, otherStudyId, 'Elsewhere');
    const bobStudyId = await createStudy(bob);
    const bobNode = await createThought(bob, bobStudyId, 'Bob');
    const deleted = await createThought(alice, studyId, 'Deleted');
    expect(
      (await send(alice, 'delete', nodePath(studyId, deleted), { expectedRevision: 1 })).status,
    ).toBe(200);

    const before = await ownerCounts(alice);
    for (const mention of [
      { nodeId, label: 'Not its label' },
      { nodeId: otherStudyNode, label: 'Elsewhere' },
      { nodeId: bobNode, label: 'Bob' },
      { nodeId: deleted, label: 'Deleted' },
      { nodeId: randomUUID(), label: 'Absent' },
    ]) {
      const res = await postNote(alice, studyId, withMentions('x', mention));
      expect([res.status, res.body]).toStrictEqual([422, MENTION_INVALID]);
    }
    expect(await ownerCounts(alice)).toStrictEqual(before);
  });

  it('keeps a stored mention through later saves after its node is edited and deleted, and reports the node as deleted', async () => {
    const studyId = await createStudy(alice);
    const nodeId = await createThought(alice, studyId, 'Old label');
    const created = await postNote(
      alice,
      studyId,
      withMentions('See ', { nodeId, label: 'Old label' }),
    );
    const note = created.body as CreateNoteResponse;

    expect(
      (
        await send(alice, 'patch', nodePath(studyId, nodeId), {
          expectedRevision: 1,
          text: 'New label',
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(alice, 'delete', nodePath(studyId, nodeId), { expectedRevision: 2 })).status,
    ).toBe(200);

    const saved = await send(alice, 'patch', notePath(studyId, note.id), {
      expectedRevision: 1,
      content: withMentions('Still see ', { nodeId, label: 'Old label' }),
    });
    expect(saved.status).toBe(200);
    const read = await send(alice, 'get', notePath(studyId, note.id));
    expect((read.body as { deletedMentionNodeIds: string[] }).deletedMentionNodeIds).toStrictEqual([
      nodeId,
    ]);

    // A new mention of the deleted node is refused.
    const second = await send(alice, 'patch', notePath(studyId, note.id), {
      expectedRevision: 2,
      content: withMentions('x', { nodeId, label: 'Old label' }, { nodeId, label: 'New label' }),
    });
    expect([second.status, second.body]).toStrictEqual([422, MENTION_INVALID]);
  });

  it('refuses a mention with marks or extra attributes (400)', async () => {
    const studyId = await createStudy(alice);
    const nodeId = await createThought(alice, studyId, 'T');
    for (const mention of [
      { type: 'nodeMention', attrs: { nodeId, label: 'T' }, marks: [{ type: 'bold' }] },
      { type: 'nodeMention', attrs: { nodeId, label: 'T', href: 'https://example.test' } },
      { type: 'nodeMention', attrs: { nodeId: 'not-a-uuid', label: 'T' } },
    ]) {
      const res = await send(alice, 'post', notesPath(studyId), {
        expectedRevision: await studyRevision(studyId),
        content: { type: 'doc', content: [{ type: 'paragraph', content: [mention] }] },
      });
      expect(res.status).toBe(400);
    }
  });
});
