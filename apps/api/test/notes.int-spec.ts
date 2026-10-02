import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import {
  type CaptureAnchorResponse,
  type CreateNoteResponse,
  type CreateStudyResponse,
  type NoteDocument,
  type NoteListResponse,
  type NoteMutationResponse,
  type NoteResponse,
  type NoteVersionListResponse,
  type ResolveReferenceResponse,
  type ScriptureReference,
  type StudyListResponse,
} from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { NoteVersion } from '../src/database/models/note-version.model';
import { Note } from '../src/database/models/note.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
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
const notesPath = (studyId: string): string => `/v1/studies/${studyId}/notes`;
const notePath = (studyId: string, noteId: string): string =>
  `/v1/studies/${studyId}/notes/${noteId}`;
const noteRestorePath = (studyId: string, noteId: string): string =>
  `/v1/studies/${studyId}/notes/${noteId}/restore`;
const noteVersionsPath = (studyId: string, noteId: string): string =>
  `/v1/studies/${studyId}/notes/${noteId}/versions`;
const noteVersionPath = (studyId: string, noteId: string, versionId: string): string =>
  `/v1/studies/${studyId}/notes/${noteId}/versions/${versionId}`;

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
const TARGET_NOT_FOUND = envelope({
  code: 'NOTE_TARGET_NOT_FOUND',
  message: 'That item is not part of this study',
});
const NOTE_UNCHANGED = envelope({
  code: 'NOTE_UNCHANGED',
  message: 'The note already has this content and version',
});
const NOTE_TRASHED = envelope({
  code: 'NOTE_TRASHED',
  message: 'This note is in the trash. Restore it to make changes',
});
const NOTE_NOT_TRASHED = envelope({
  code: 'NOTE_NOT_TRASHED',
  message: 'This note is not in the trash',
});
const NOTE_TOO_LONG = envelope({
  code: 'NOTE_TOO_LONG',
  message: 'A note can have at most 50,000 characters',
});
const PAYLOAD_TOO_LARGE = envelope({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload Too Large' });
const INVALID = envelope({
  code: 'VALIDATION',
  message: 'Invalid request',
  fieldErrors: expect.any(Object) as Record<string, string[]>,
});
const STUDY_ARCHIVED = envelope({
  code: 'STUDY_ARCHIVED',
  message: 'This study is archived. Unarchive it to make changes',
});
const STUDY_TRASHED = envelope({
  code: 'STUDY_TRASHED',
  message: 'This study is in the trash. Restore it to make changes',
});

/** A document of plain paragraphs. */
const doc = (...paragraphs: string[]): NoteDocument => ({
  type: 'doc',
  content: paragraphs.map((text) =>
    text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] },
  ),
});

/** Every construct the editor offers. */
const RICH: NoteDocument = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Conscience' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bears ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'witness', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'hardBreak' },
        {
          type: 'text',
          text: 'a source',
          marks: [{ type: 'link', attrs: { href: 'https://example.org/conscience' } }],
        },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 2 },
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Romans 2' }] },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'verse 15' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'συνείδησις 🙂' }] }],
    },
  ],
};
const RICH_TEXT = 'Conscience\nBears witness\na source\nRomans 2\nverse 15\nσυνείδησις 🙂';

/** BIB-23: rich notes on studies and nodes, with checkpoint versions. Real PostgreSQL. */
describe('notes (BIB-23)', () => {
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

  async function createStudy(
    owner: Owner,
    body: object = { question: 'What is conscience?' },
  ): Promise<CreateStudyResponse> {
    const res = await request(app.getHttpServer())
      .post(STUDIES)
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(201);
    return res.body as CreateStudyResponse;
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
    if (typeof body === 'string') req = req.set('Content-Type', 'application/json').send(body);
    else if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  async function studyRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
  }

  async function contentRevision(studyId: string): Promise<number> {
    return (await Study.findByPk(studyId, { rejectOnEmpty: true })).contentRevision;
  }

  /** Creates a note through the API; returns its 201 body. */
  async function createNote(
    owner: Owner,
    studyId: string,
    content: NoteDocument = doc('First thoughts'),
    extra: object = {},
  ): Promise<CreateNoteResponse> {
    const res = await send(owner, 'post', notesPath(studyId), {
      expectedRevision: await studyRevision(studyId),
      content,
      ...extra,
    });
    expect([res.status, res.body]).toStrictEqual([201, expect.any(Object)]);
    return res.body as CreateNoteResponse;
  }

  async function save(owner: Owner, studyId: string, noteId: string, body: object, key?: string) {
    return send(owner, 'patch', notePath(studyId, noteId), body, key);
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({ eventType: e.eventType, payload: e.payloadJson }));
  }

  async function versionNumbers(noteId: string): Promise<number[]> {
    const rows = await NoteVersion.findAll({
      where: { noteId },
      order: [['versionNumber', 'ASC']],
    });
    return rows.map((row) => row.versionNumber);
  }

  /** Every row a note mutation of this owner may write, to prove a refusal wrote nothing. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: ['id', 'revision', 'contentRevision', 'lastEventSequence'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      notes: await Note.findAll({
        where,
        attributes: ['id', 'revision', 'plainText', 'deletedAt', 'latestVersionNumber'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      versions: await NoteVersion.count({ where }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  /**
   * Moves a note's versions back by `seconds` on the database clock. Versions are immutable (a
   * trigger refuses UPDATE), so the test lifts the trigger inside one transaction.
   */
  async function versionsAged(noteId: string, seconds: number): Promise<void> {
    await db.transaction(async (transaction) => {
      await db.query('ALTER TABLE note_version DISABLE TRIGGER note_version_immutable', {
        transaction,
      });
      await db.query(
        `UPDATE note_version SET created_at = created_at - make_interval(secs => $2)
          WHERE note_id = $1`,
        { bind: [noteId, seconds], transaction, type: QueryTypes.UPDATE },
      );
      await db.query('ALTER TABLE note_version ENABLE TRIGGER note_version_immutable', {
        transaction,
      });
    });
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

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its notes and their versions.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('create and read', () => {
    it('creates a study note and a note on the main question; a reload returns the same document, derived text and target', async () => {
      const study = await createStudy(alice);
      const before = await contentRevision(study.studyId);

      const created = await send(alice, 'post', notesPath(study.studyId), {
        expectedRevision: 1,
        content: RICH,
      });
      expect([created.status, created.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId: study.studyId,
          revision: 1,
          targetNodeId: null,
          targetReferenceId: null,
          characterCount: [...RICH_TEXT].length,
          latestVersionNumber: 1,
          createdAt: anyTime,
          updatedAt: anyTime,
          deletedAt: null,
          lastEventSequence: '2',
          studyRevision: 2,
        },
      ]);
      const note = created.body as CreateNoteResponse;
      const onQuestion = await createNote(alice, study.studyId, doc('On the question'), {
        targetNodeId: study.questionNodeId,
      });

      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      expect([read.status, read.body]).toStrictEqual([
        200,
        {
          id: note.id,
          studyId: study.studyId,
          revision: 1,
          target: null,
          targetAnchor: null,
          content: RICH,
          characterCount: [...RICH_TEXT].length,
          latestVersionNumber: 1,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          deletedAt: null,
        },
      ]);
      expect(read.headers['cache-control']).toBe('no-store');
      const stored = await Note.findByPk(note.id, { rejectOnEmpty: true });
      expect([stored.plainText, stored.searchText]).toStrictEqual([
        RICH_TEXT,
        'conscience bears witness a source romans 2 verse 15 συνείδησισ 🙂',
      ]);

      const list = await send(alice, 'get', notesPath(study.studyId));
      expect([list.status, list.body]).toStrictEqual([
        200,
        {
          items: [
            {
              id: onQuestion.id,
              revision: 1,
              target: {
                kind: 'node',
                nodeId: study.questionNodeId,
                nodeType: 'question',
                label: 'What is conscience?',
                deleted: false,
              },
              preview: 'On the question',
              characterCount: 15,
              createdAt: onQuestion.createdAt,
              updatedAt: onQuestion.updatedAt,
              deletedAt: null,
            },
            {
              id: note.id,
              revision: 1,
              target: null,
              preview: RICH_TEXT.replace(/\n/g, ' '),
              characterCount: [...RICH_TEXT].length,
              createdAt: note.createdAt,
              updatedAt: note.updatedAt,
              deletedAt: null,
            },
          ],
        },
      ]);

      // Version 1 holds the created content; one thread-visible event per note, ids only.
      const versions = await NoteVersion.findAll({ where: { noteId: note.id }, raw: true });
      expect(versions.map((v) => [v.versionNumber, v.richTextJson, v.plainText])).toStrictEqual([
        [1, RICH, RICH_TEXT],
      ]);
      expect((await events(study.studyId)).slice(1)).toStrictEqual([
        {
          eventType: 'note_created',
          payload: {
            noteId: note.id,
            targetNodeId: null,
            targetReferenceId: null,
            versionId: versions[0]?.id,
          },
        },
        {
          eventType: 'note_created',
          payload: {
            noteId: onQuestion.id,
            targetNodeId: study.questionNodeId,
            targetReferenceId: null,
            versionId: expect.stringMatching(UUID),
          },
        },
      ]);
      // A new note is a study change and study content.
      expect(await studyRevision(study.studyId)).toBe(3);
      expect(await contentRevision(study.studyId)).toBe(before + 2);
    });

    it("labels a note on a Scripture node with the node's reference", async () => {
      const edition = await BibleEdition.findOne({
        where: {
          code: ENGWEBP_RELEASE.code,
          sourceRelease: ENGWEBP_RELEASE.sourceRelease,
          activatedAt: { [Op.ne]: null },
        },
        rejectOnEmpty: true,
      });
      const resolved = await send(alice, 'post', '/v1/bible/resolve', {
        input: 'Rom 9:1',
        editionId: edition.id,
      });
      const outcome = resolved.body as ResolveReferenceResponse;
      if (outcome.outcome !== 'resolved') throw new Error('expected a resolved reference');
      const study = await createStudy(alice, { startingReferenceId: outcome.reference.id });
      const note = await createNote(alice, study.studyId, doc('Paul swears'), {
        targetNodeId: study.rootNodeId,
      });
      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      expect((read.body as { target: unknown }).target).toStrictEqual({
        kind: 'node',
        nodeId: study.rootNodeId,
        nodeType: 'scripture',
        label: 'Romans 9:1',
        deleted: false,
      });
    });

    it('refuses a target that is not a live node of this study with 422 NOTE_TARGET_NOT_FOUND, writing nothing', async () => {
      const study = await createStudy(alice);
      const otherStudy = await createStudy(alice);
      const bobsStudy = await createStudy(bob);
      const deleted = await StudyNode.create({
        studyId: study.studyId,
        ownerId: alice.user.id,
        type: 'thought',
        deletedAt: new Date(),
      });
      const before = await ownerRows(alice);
      const answers: unknown[] = [];
      for (const targetNodeId of [
        randomUUID(),
        otherStudy.questionNodeId,
        bobsStudy.questionNodeId,
        deleted.id,
      ]) {
        const res = await send(alice, 'post', notesPath(study.studyId), {
          expectedRevision: 1,
          content: doc('x'),
          targetNodeId,
        });
        answers.push([res.status, res.body]);
      }
      expect(answers).toStrictEqual(Array.from({ length: 4 }, () => [422, TARGET_NOT_FOUND]));
      expect(await ownerRows(alice)).toStrictEqual(before);
    });

    it('needs the study revision to create (428 missing, 409 stale) and replays a retried creation', async () => {
      const study = await createStudy(alice);
      const missing = await send(alice, 'post', notesPath(study.studyId), { content: doc('x') });
      const stale = await send(alice, 'post', notesPath(study.studyId), {
        expectedRevision: 7,
        content: doc('x'),
      });
      expect([
        [missing.status, missing.body],
        [stale.status, stale.body],
      ]).toStrictEqual([
        [428, REVISION_MISSING],
        [409, conflict(1)],
      ]);
      const key = randomUUID();
      const body = { expectedRevision: 1, content: doc('Once') };
      const first = await send(alice, 'post', notesPath(study.studyId), body, key);
      const replay = await send(alice, 'post', notesPath(study.studyId), body, key);
      expect([replay.status, replay.body, replay.headers['idempotent-replayed']]).toStrictEqual([
        201,
        first.body,
        'true',
      ]);
      expect(await Note.count({ where: { studyId: study.studyId } })).toBe(1);
    });
  });

  describe('Scripture targets and verified reference links (BIB-24)', () => {
    let editionId: string;

    beforeAll(async () => {
      const edition = await BibleEdition.findOne({
        where: {
          code: ENGWEBP_RELEASE.code,
          sourceRelease: ENGWEBP_RELEASE.sourceRelease,
          activatedAt: { [Op.ne]: null },
        },
        rejectOnEmpty: true,
      });
      editionId = edition.id;
    });

    async function reference(input: string): Promise<ScriptureReference> {
      const res = await send(alice, 'post', '/v1/bible/resolve', { input, editionId });
      const body = res.body as ResolveReferenceResponse;
      if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
      return body.reference;
    }

    /** The first three words of Romans 9:1, captured by `POST /bible/anchors` as the reader does. */
    async function phrase(): Promise<CaptureAnchorResponse> {
      const verse = await BibleVerse.findOne({
        where: { editionId, bookCode: 'ROM', chapter: 9, verse: 1 },
        rejectOnEmpty: true,
      });
      const quote = verse.text.split(' ').slice(0, 3).join(' ');
      const res = await send(alice, 'post', '/v1/bible/anchors', {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 0, end: Array.from(quote).length }],
        quote,
      });
      expect(res.status).toBe(200);
      return res.body as CaptureAnchorResponse;
    }

    /** A paragraph holding text, a verified reference link, and more text. */
    const withLink = (referenceId: string, label: string): NoteDocument => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'scriptureReference', attrs: { referenceId, label } },
            { type: 'text', text: ' on conscience' },
          ],
        },
      ],
    });

    it('attaches a note to a phrase: the anchor is stored as captured and read back resolved with its reference', async () => {
      const study = await createStudy(alice);
      const { anchor, reference: ref } = await phrase();
      const created = await send(alice, 'post', notesPath(study.studyId), {
        expectedRevision: 1,
        targetAnchor: anchor,
        content: doc('Paul swears'),
      });
      expect([created.status, created.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId: study.studyId,
          revision: 1,
          targetNodeId: null,
          targetReferenceId: ref.id,
          characterCount: 11,
          latestVersionNumber: 1,
          createdAt: anyTime,
          updatedAt: anyTime,
          deletedAt: null,
          lastEventSequence: '2',
          studyRevision: 2,
        },
      ]);
      const note = created.body as CreateNoteResponse;
      const target = { kind: 'scripture', anchorKind: 'phrase', reference: ref, problem: null };
      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      const list = await send(alice, 'get', notesPath(study.studyId));
      expect({
        read: [
          read.status,
          (read.body as NoteResponse).target,
          (read.body as NoteResponse).targetAnchor,
        ],
        list: (list.body as NoteListResponse).items.map((item) => item.target),
        events: (await events(study.studyId)).slice(1),
      }).toStrictEqual({
        read: [200, target, anchor],
        list: [target],
        events: [
          {
            eventType: 'note_created',
            payload: {
              noteId: note.id,
              targetNodeId: null,
              targetReferenceId: ref.id,
              versionId: anyId,
            },
          },
        ],
      });
    });

    it('refuses a Scripture target that does not match the corpus (422 with its code) or comes with a node target (400), writing nothing', async () => {
      const study = await createStudy(alice);
      const { anchor } = await phrase();
      const before = await ownerRows(alice);
      const answers = [
        await send(alice, 'post', notesPath(study.studyId), {
          expectedRevision: 1,
          targetAnchor: { ...anchor, quote: `${anchor.quote}!` },
          content: doc('x'),
        }),
        await send(alice, 'post', notesPath(study.studyId), {
          expectedRevision: 1,
          targetAnchor: anchor,
          targetNodeId: study.questionNodeId,
          content: doc('x'),
        }),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [
            422,
            envelope({
              code: 'ANCHOR_QUOTE_MISMATCH',
              message: 'The selected text does not match this translation',
            }),
          ],
          [400, INVALID],
        ],
        unchanged: true,
      });
    });

    it('reports a Scripture target that no longer matches the corpus, keeping its original anchor', async () => {
      const study = await createStudy(alice);
      const { anchor, reference: ref } = await phrase();
      const note = await createNote(alice, study.studyId, doc('x'), { targetAnchor: anchor });
      const drifted = { ...anchor, quote: `${anchor.quote} (as remembered)` };
      await Note.update({ targetAnchorJson: drifted }, { where: { id: note.id } });
      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      const body = read.body as NoteResponse;
      expect([body.target, body.targetAnchor]).toStrictEqual([
        {
          kind: 'scripture',
          anchorKind: 'phrase',
          reference: ref,
          problem: 'ANCHOR_QUOTE_MISMATCH',
        },
        drifted,
      ]);
    });

    it('saves a verified reference link with its label in the plain text, creating no node and no other event', async () => {
      const study = await createStudy(alice);
      const ref = await reference('Rom 9:1');
      const nodesBefore = await StudyNode.count({ where: { studyId: study.studyId } });
      const note = await createNote(alice, study.studyId, doc('draft'));
      const saved = await save(alice, study.studyId, note.id, {
        expectedRevision: 1,
        content: withLink(ref.id, ref.label),
        checkpoint: true,
      });
      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      const stored = await Note.findByPk(note.id, { rejectOnEmpty: true });
      expect({
        saved: saved.status,
        content: (read.body as NoteResponse).content,
        plainText: stored.plainText,
        nodes: await StudyNode.count({ where: { studyId: study.studyId } }),
        events: (await events(study.studyId)).slice(1).map((e) => e.eventType),
      }).toStrictEqual({
        saved: 200,
        content: withLink(ref.id, ref.label),
        plainText: `See ${ref.label} on conscience`,
        nodes: nodesBefore,
        events: ['note_created', 'note_autosaved'],
      });
    });

    it('refuses a reference link to an unknown reference or with another label (422 NOTE_REFERENCE_INVALID) and malformed ones (400), on create and save, writing nothing', async () => {
      const study = await createStudy(alice);
      const ref = await reference('Rom 9:1');
      const note = await createNote(alice, study.studyId, doc('x'));
      const REFERENCE_INVALID = envelope({
        code: 'NOTE_REFERENCE_INVALID',
        message: 'A Bible reference link in this note could not be verified',
      });
      const before = await ownerRows(alice);
      const bad: [NoteDocument | object, unknown][] = [
        [withLink(randomUUID(), ref.label), REFERENCE_INVALID],
        [withLink(ref.id, 'Romans 9:2'), REFERENCE_INVALID],
        [withLink(ref.id, `${ref.label} `), REFERENCE_INVALID],
        [
          {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'scriptureReference',
                    attrs: { referenceId: ref.id, label: ref.label, href: 'javascript:alert(1)' },
                  },
                ],
              },
            ],
          },
          INVALID,
        ],
        [withLink('not-a-uuid', ref.label), INVALID],
      ];
      const answers: unknown[] = [];
      for (const [content] of bad) {
        for (const res of [
          await send(alice, 'post', notesPath(study.studyId), {
            expectedRevision: await studyRevision(study.studyId),
            content,
          }),
          await save(alice, study.studyId, note.id, { expectedRevision: 1, content }),
        ]) {
          answers.push([res.status, res.body]);
        }
      }
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: bad.flatMap(([, body]) => [
          [body === INVALID ? 400 : 422, body],
          [body === INVALID ? 400 : 422, body],
        ]),
        unchanged: true,
      });
    });
  });

  describe('rich text safety (NFR-SEC-002)', () => {
    const SENTINEL = 'sentinel-7f1c2b';
    const textRun = (extra: object) =>
      ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SENTINEL, ...extra }] }],
      }) as unknown;
    let deep: unknown = { type: 'paragraph', content: [{ type: 'text', text: SENTINEL }] };
    for (let level = 0; level < 11; level += 1) deep = { type: 'blockquote', content: [deep] };
    // Sent as raw JSON text: 200,000 nested arrays (about 400 kB), deeper than any recursive
    // parser or serializer could follow. (The test client's own JSON.stringify could not build it.)
    const HOSTILE_NESTING = `{"type":"doc","content":[${'['.repeat(200_000)}${']'.repeat(200_000)}]}`;

    it.each([
      [
        'a javascript: link',
        textRun({ marks: [{ type: 'link', attrs: { href: `javascript:alert('${SENTINEL}')` } }] }),
      ],
      [
        'a data: link',
        textRun({
          marks: [{ type: 'link', attrs: { href: `data:text/html,<script>${SENTINEL}</script>` } }],
        }),
      ],
      [
        'a link with a target attribute',
        textRun({ marks: [{ type: 'link', attrs: { href: 'https://x.test', target: '_self' } }] }),
      ],
      ['a script-like mark', textRun({ marks: [{ type: 'script', attrs: { src: SENTINEL } }] })],
      [
        'an unknown node',
        {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: `https://x.test/${SENTINEL}.png` } }],
        },
      ],
      [
        'raw HTML',
        { type: 'doc', content: [{ type: 'html', content: `<img src=x onerror="${SENTINEL}">` }] },
      ],
      [
        'an event-handler attribute',
        { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: SENTINEL } }] },
      ],
      ['a control character', textRun({ text: `${SENTINEL}\u0007` })],
      ['13 nesting levels', { type: 'doc', content: [deep] }],
      ['200,000 nested arrays', HOSTILE_NESTING],
    ])(
      'refuses %s on create and save with 400, writing nothing and echoing nothing',
      async (_label, content) => {
        const study = await createStudy(alice);
        const note = await createNote(alice, study.studyId);
        const before = await ownerRows(alice);
        const revision = await studyRevision(study.studyId);
        const bodyOf = (expectedRevision: number): unknown =>
          typeof content === 'string'
            ? `{"expectedRevision":${expectedRevision},"content":${content}}`
            : { expectedRevision, content };
        const created = await send(
          alice,
          'post',
          notesPath(study.studyId),
          bodyOf(revision),
          randomUUID(),
        );
        const saved = await save(alice, study.studyId, note.id, bodyOf(1) as object, randomUUID());
        expect([
          [created.status, created.body],
          [saved.status, saved.body],
        ]).toStrictEqual([
          [400, INVALID],
          [400, INVALID],
        ]);
        expect(JSON.stringify([created.body, saved.body])).not.toContain(SENTINEL);
        expect(await ownerRows(alice)).toStrictEqual(before);
      },
    );

    it('refuses plain text over 50,000 characters with 413 NOTE_TOO_LONG and a body over 1 MiB with 413, writing nothing; a long non-ASCII note within the limit saves', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId);
      const before = await ownerRows(alice);
      const tooLong = doc('a'.repeat(50_001));
      const tooBig = doc(...Array.from({ length: 30 }, () => 'b'.repeat(40_000)));
      const answers = [
        await send(alice, 'post', notesPath(study.studyId), {
          expectedRevision: 2,
          content: tooLong,
        }),
        await save(alice, study.studyId, note.id, { expectedRevision: 1, content: tooLong }),
        await send(alice, 'post', notesPath(study.studyId), {
          expectedRevision: 2,
          content: tooBig,
        }),
        await save(alice, study.studyId, note.id, { expectedRevision: 1, content: tooBig }),
      ];
      expect(answers.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
        [413, NOTE_TOO_LONG],
        [413, NOTE_TOO_LONG],
        [413, PAYLOAD_TOO_LARGE],
        [413, PAYLOAD_TOO_LARGE],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);

      // 49,999 characters of polytonic Greek (3 UTF-8 bytes each): about 150 kB, past the default
      // 100 kB JSON limit every other route keeps, and one character under the limit
      // (10 paragraphs of 4,999 code points, an emoji counting as one, and 9 line breaks).
      const greek = doc(...Array.from({ length: 10 }, (_, i) => `${'ἀ'.repeat(4_997)}🙂${i}`));
      const saved = await save(alice, study.studyId, note.id, {
        expectedRevision: 1,
        content: greek,
      });
      expect([saved.status, (saved.body as NoteMutationResponse).characterCount]).toStrictEqual([
        200, 49_999,
      ]);
      // Only note routes take large bodies.
      const study200k = await send(alice, 'patch', `${STUDIES}/${study.studyId}`, {
        expectedRevision: await studyRevision(study.studyId),
        description: 'd'.repeat(200_000),
      });
      expect([study200k.status, study200k.body]).toStrictEqual([413, PAYLOAD_TOO_LARGE]);
    });
    it('reads a large note body only for a signed-in client: an anonymous or forged-cookie body past the default 100 kB is 413 before the guard, a small one 401', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId);
      // About 120 kB of polytonic Greek: over the default 100 kB limit, under the note limit.
      const large = { expectedRevision: 2, content: doc('ἀ'.repeat(40_000)) };
      const forged: Owner = { ...alice, cookie: `ba_session=${'A'.repeat(43)}` };
      const before = await ownerRows(alice);
      const answers = [];
      for (const who of [null, forged]) {
        answers.push(
          await send(who, 'post', notesPath(study.studyId), large),
          await send(who, 'patch', notePath(study.studyId, note.id), large),
          await send(who, 'post', notesPath(study.studyId), { expectedRevision: 2 }),
        );
      }
      expect(answers.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
        [413, PAYLOAD_TOO_LARGE],
        [413, PAYLOAD_TOO_LARGE],
        [401, UNAUTHENTICATED],
        [413, PAYLOAD_TOO_LARGE],
        [413, PAYLOAD_TOO_LARGE],
        [401, UNAUTHENTICATED],
      ]);
      expect(await ownerRows(alice)).toStrictEqual(before);
      // The owner's identical body is read with the note limit and saved.
      const created = await send(alice, 'post', notesPath(study.studyId), large);
      expect(created.status).toBe(201);
    });
  });

  describe('saving and versions', () => {
    it('saves new content with expectedRevision: 428 without it, 409 when stale, a replay for a retried key and 422 for the key with another body', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId);
      const missing = await save(alice, study.studyId, note.id, { content: doc('x') });
      const key = randomUUID();
      const body = { expectedRevision: 1, content: doc('Second thoughts') };
      const first = await save(alice, study.studyId, note.id, body, key);
      expect([first.status, first.body]).toStrictEqual([
        200,
        {
          id: note.id,
          studyId: study.studyId,
          revision: 2,
          targetNodeId: null,
          targetReferenceId: null,
          characterCount: 15,
          latestVersionNumber: 1,
          createdAt: note.createdAt,
          updatedAt: anyTime,
          deletedAt: null,
          lastEventSequence: '3',
        },
      ]);
      const replay = await save(alice, study.studyId, note.id, body, key);
      const reused = await save(
        alice,
        study.studyId,
        note.id,
        { ...body, content: doc('Other') },
        key,
      );
      const stale = await save(alice, study.studyId, note.id, body);
      expect([
        [missing.status, missing.body],
        [replay.status, replay.body, replay.headers['idempotent-replayed']],
        [reused.status, reused.body],
        [stale.status, stale.body],
      ]).toStrictEqual([
        [428, REVISION_MISSING],
        [200, first.body, 'true'],
        [422, KEY_REUSED],
        [409, conflict(2)],
      ]);
      expect((await Note.findByPk(note.id, { rejectOnEmpty: true })).plainText).toBe(
        'Second thoughts',
      );
      // The stored response (replayed for the retry) carries no note text.
      const receipt = await MutationReceipt.findOne({
        where: { ownerId: alice.user.id, idempotencyKey: key },
        rejectOnEmpty: true,
      });
      expect(JSON.stringify(receipt.responseBody)).not.toContain('thoughts');
      expect((await events(study.studyId)).at(-1)).toStrictEqual({
        eventType: 'note_autosaved',
        payload: { noteId: note.id, versionId: null },
      });
    });

    it('writes a version for a checkpoint or after 30 s of edits on the database clock, never a copy of the newest version, and moves content revision only then', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId, doc('v1'));
      let revision = 1;
      const step = async (body: object) => {
        const before = await contentRevision(study.studyId);
        const res = await save(alice, study.studyId, note.id, {
          expectedRevision: revision,
          ...body,
        });
        if (res.status === 200) revision += 1;
        return {
          status: res.status,
          body: res.status === 200 ? 'saved' : res.body,
          versions: await versionNumbers(note.id),
          contentMoved: (await contentRevision(study.studyId)) - before,
        };
      };

      // Fresh version 1: an edit is an autosave without a version.
      expect(await step({ content: doc('draft a') })).toStrictEqual({
        status: 200,
        body: 'saved',
        versions: [1],
        contentMoved: 0,
      });
      // Version 1 is 31 s old by the database clock: the next edit writes version 2.
      await versionsAged(note.id, 31);
      expect(await step({ content: doc('draft b') })).toStrictEqual({
        status: 200,
        body: 'saved',
        versions: [1, 2],
        contentMoved: 1,
      });
      // Nothing new: a checkpoint of content the newest version already holds changes nothing.
      expect(await step({ checkpoint: true })).toStrictEqual({
        status: 422,
        body: NOTE_UNCHANGED,
        versions: [1, 2],
        contentMoved: 0,
      });
      expect(await step({ content: doc('draft b') })).toStrictEqual({
        status: 422,
        body: NOTE_UNCHANGED,
        versions: [1, 2],
        contentMoved: 0,
      });
      // An explicit checkpoint with new content: version 3 at once.
      expect(await step({ content: doc('draft c'), checkpoint: true })).toStrictEqual({
        status: 200,
        body: 'saved',
        versions: [1, 2, 3],
        contentMoved: 1,
      });
      // Edits inside the interval: autosaves only; then "Save version" checkpoints them.
      expect(await step({ content: doc('draft d') })).toStrictEqual({
        status: 200,
        body: 'saved',
        versions: [1, 2, 3],
        contentMoved: 0,
      });
      expect(await step({ checkpoint: true })).toStrictEqual({
        status: 200,
        body: 'saved',
        versions: [1, 2, 3, 4],
        contentMoved: 1,
      });
      const stored = await NoteVersion.findAll({
        where: { noteId: note.id },
        order: [['versionNumber', 'ASC']],
      });
      expect(stored.map((v) => v.plainText)).toStrictEqual(['v1', 'draft b', 'draft c', 'draft d']);
      expect((await Note.findByPk(note.id, { rejectOnEmpty: true })).latestVersionNumber).toBe(4);
    });

    it('keeps only the newest 100 versions; numbers keep increasing and are never reused', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId, doc('version 1'));
      for (let n = 2; n <= 102; n += 1) {
        const res = await save(alice, study.studyId, note.id, {
          expectedRevision: n - 1,
          content: doc(`version ${n}`),
          checkpoint: true,
        });
        expect(res.status).toBe(200);
      }
      const numbers = await versionNumbers(note.id);
      expect([numbers.length, numbers[0], numbers.at(-1)]).toStrictEqual([100, 3, 102]);

      const listed = await send(alice, 'get', noteVersionsPath(study.studyId, note.id));
      const items = (listed.body as NoteVersionListResponse).items;
      expect([listed.status, items.length, items[0], items.at(-1)?.versionNumber]).toStrictEqual([
        200,
        100,
        {
          id: anyId,
          versionNumber: 102,
          preview: 'version 102',
          characterCount: 11,
          createdAt: anyTime,
        },
        3,
      ]);
    });

    it('reads one version with its content, and restoring it saves that content as a new checkpoint', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId, RICH);
      await save(alice, study.studyId, note.id, {
        expectedRevision: 1,
        content: doc('rewritten'),
        checkpoint: true,
      });
      const first = await NoteVersion.findOne({
        where: { noteId: note.id, versionNumber: 1 },
        rejectOnEmpty: true,
      });
      const read = await send(alice, 'get', noteVersionPath(study.studyId, note.id, first.id));
      expect([read.status, read.body]).toStrictEqual([
        200,
        {
          id: first.id,
          noteId: note.id,
          versionNumber: 1,
          content: RICH,
          characterCount: [...RICH_TEXT].length,
          createdAt: first.createdAt.toISOString(),
        },
      ]);
      const restored = await save(alice, study.studyId, note.id, {
        expectedRevision: 2,
        content: (read.body as { content: NoteDocument }).content,
        checkpoint: true,
      });
      expect([
        restored.status,
        (restored.body as NoteMutationResponse).latestVersionNumber,
      ]).toStrictEqual([200, 3]);
      expect((await send(alice, 'get', notePath(study.studyId, note.id))).body).toMatchObject({
        content: RICH,
        latestVersionNumber: 3,
      });
      // Another note's version is not this note's: 404.
      const other = await createNote(alice, study.studyId);
      const crossed = await send(alice, 'get', noteVersionPath(study.studyId, other.id, first.id));
      expect([crossed.status, crossed.body]).toStrictEqual([404, NOT_FOUND]);
    });

    it('serializes two saves racing from one revision: exactly one commits, the other is 409 with the current revision', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId);
      const gate = await db.transaction();
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [study.studyId],
        transaction: gate,
      });
      const pending = [
        save(alice, study.studyId, note.id, { expectedRevision: 1, content: doc('device one') }),
        save(alice, study.studyId, note.id, { expectedRevision: 1, content: doc('device two') }),
      ];
      await lockWaiters(2);
      await gate.rollback();
      const results = await Promise.all(pending);
      expect(results.map((res) => res.status).sort()).toStrictEqual([200, 409]);
      const loser = results.find((res) => res.status === 409);
      expect(loser?.body).toStrictEqual(conflict(2));
      const winner = results.find((res) => res.status === 200);
      const stored = await Note.findByPk(note.id, { rejectOnEmpty: true });
      expect([stored.revision, stored.plainText]).toStrictEqual([
        2,
        winner === results[0] ? 'device one' : 'device two',
      ]);
      expect(
        (await events(study.studyId)).filter((e) => e.eventType === 'note_autosaved'),
      ).toHaveLength(1);
    });

    it('runs concurrent duplicates with one Idempotency-Key once: one save, one event, the other replays', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId);
      const key = randomUUID();
      const body = { expectedRevision: 1, content: doc('only once'), checkpoint: true };
      const gate = await db.transaction();
      await db.query('SELECT 1 FROM study WHERE id = $1 FOR UPDATE', {
        bind: [study.studyId],
        transaction: gate,
      });
      const pending = [
        save(alice, study.studyId, note.id, body, key),
        save(alice, study.studyId, note.id, body, key),
      ];
      await lockWaiters(2);
      await gate.rollback();
      const results = await Promise.all(pending);
      expect(results.map((res): unknown[] => [res.status, res.body])).toStrictEqual([
        [200, results[0]?.body],
        [200, results[0]?.body],
      ]);
      expect(
        results.map((res) => res.headers['idempotent-replayed'] ?? 'executed').sort(),
      ).toStrictEqual(['executed', 'true']);
      expect(await versionNumbers(note.id)).toStrictEqual([1, 2]);
      expect(
        (await events(study.studyId)).filter((e) => e.eventType === 'note_autosaved'),
      ).toHaveLength(1);
    });
  });

  describe('trash, lifecycle and orphans', () => {
    it('moves a note to the note trash and restores it with its content and versions; wrong-state changes are 422', async () => {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId, doc('keep me'));
      const before = await contentRevision(study.studyId);
      const trashed = await send(alice, 'delete', notePath(study.studyId, note.id), {
        expectedRevision: 1,
      });
      expect([trashed.status, trashed.body]).toStrictEqual([
        200,
        {
          id: note.id,
          studyId: study.studyId,
          revision: 2,
          targetNodeId: null,
          targetReferenceId: null,
          characterCount: 7,
          latestVersionNumber: 1,
          createdAt: note.createdAt,
          updatedAt: anyTime,
          deletedAt: anyTime,
          lastEventSequence: '3',
        },
      ]);
      const active = await send(alice, 'get', notesPath(study.studyId));
      const trash = await send(alice, 'get', `${notesPath(study.studyId)}?state=trashed`);
      expect([
        (active.body as NoteListResponse).items,
        (trash.body as NoteListResponse).items.map((item) => [item.id, item.deletedAt]),
      ]).toStrictEqual([[], [[note.id, (trashed.body as NoteMutationResponse).deletedAt]]]);
      // Readable, not editable; trashing again and restoring a live note are refused.
      const read = await send(alice, 'get', notePath(study.studyId, note.id));
      const edit = await save(alice, study.studyId, note.id, {
        expectedRevision: 2,
        content: doc('x'),
      });
      const again = await send(alice, 'delete', notePath(study.studyId, note.id), {
        expectedRevision: 2,
      });
      expect([read.status, [edit.status, edit.body], [again.status, again.body]]).toStrictEqual([
        200,
        [422, NOTE_TRASHED],
        [422, NOTE_TRASHED],
      ]);

      const restored = await send(alice, 'post', noteRestorePath(study.studyId, note.id), {
        expectedRevision: 2,
      });
      const twice = await send(alice, 'post', noteRestorePath(study.studyId, note.id), {
        expectedRevision: 3,
      });
      expect([
        [restored.status, (restored.body as NoteMutationResponse).deletedAt],
        [twice.status, twice.body],
      ]).toStrictEqual([
        [200, null],
        [422, NOTE_NOT_TRASHED],
      ]);
      expect((await send(alice, 'get', notePath(study.studyId, note.id))).body).toMatchObject({
        content: doc('keep me'),
        latestVersionNumber: 1,
        deletedAt: null,
      });
      expect((await events(study.studyId)).slice(-2)).toStrictEqual([
        { eventType: 'note_trashed', payload: { noteId: note.id } },
        { eventType: 'note_restored', payload: { noteId: note.id } },
      ]);
      expect(await contentRevision(study.studyId)).toBe(before + 2);
      // Bad state filter: 400.
      const badState = await send(alice, 'get', `${notesPath(study.studyId)}?state=all`);
      expect([badState.status, badState.body]).toStrictEqual([400, INVALID]);
    });

    it('refuses every note mutation on an archived or trashed study with 422 and writes nothing, while its notes stay readable', async () => {
      const answersFor = async (lifecycle: 'archive' | 'trash') => {
        const study = await createStudy(alice);
        const note = await createNote(alice, study.studyId);
        await send(alice, 'patch', notePath(study.studyId, note.id), {
          expectedRevision: 1,
          content: doc('trash me'),
        });
        const res =
          lifecycle === 'archive'
            ? await send(alice, 'post', `${STUDIES}/${study.studyId}/archive`, {
                expectedRevision: 2,
              })
            : await send(alice, 'delete', `${STUDIES}/${study.studyId}`, { expectedRevision: 2 });
        expect(res.status).toBe(200);
        const before = await ownerRows(alice);
        const answers = [
          await send(alice, 'post', notesPath(study.studyId), {
            expectedRevision: 3,
            content: doc('x'),
          }),
          await save(alice, study.studyId, note.id, { expectedRevision: 2, content: doc('y') }),
          await send(alice, 'delete', notePath(study.studyId, note.id), { expectedRevision: 2 }),
          await send(alice, 'post', noteRestorePath(study.studyId, note.id), {
            expectedRevision: 2,
          }),
        ].map((r): unknown[] => [r.status, r.body]);
        const reads = [
          await send(alice, 'get', notesPath(study.studyId)),
          await send(alice, 'get', notePath(study.studyId, note.id)),
          await send(alice, 'get', noteVersionsPath(study.studyId, note.id)),
        ].map((r) => r.status);
        return { answers, reads, unchanged: isDeepStrictEqual(await ownerRows(alice), before) };
      };
      expect(await answersFor('archive')).toStrictEqual({
        answers: Array.from({ length: 4 }, () => [422, STUDY_ARCHIVED]),
        reads: [200, 200, 200],
        unchanged: true,
      });
      expect(await answersFor('trash')).toStrictEqual({
        answers: Array.from({ length: 4 }, () => [422, STUDY_TRASHED]),
        reads: [200, 200, 200],
        unchanged: true,
      });
    });

    it('keeps a note whose target node was deleted: listed for orphaned-note review with its label, readable and editable', async () => {
      const study = await createStudy(alice, { question: 'Who bears witness?' });
      const note = await createNote(alice, study.studyId, doc('orphan to be'), {
        targetNodeId: study.questionNodeId,
      });
      // Node deletion is BIB-31's; soft-delete the node directly.
      await StudyNode.update(
        { deletedAt: new Date() },
        { where: { id: study.questionNodeId ?? '' } },
      );
      const list = await send(alice, 'get', notesPath(study.studyId));
      expect((list.body as NoteListResponse).items.map((item) => item.target)).toStrictEqual([
        {
          kind: 'node',
          nodeId: study.questionNodeId,
          nodeType: 'question',
          label: 'Who bears witness?',
          deleted: true,
        },
      ]);
      const edited = await save(alice, study.studyId, note.id, {
        expectedRevision: 1,
        content: doc('still mine'),
      });
      expect([edited.status, (edited.body as NoteMutationResponse).targetNodeId]).toStrictEqual([
        200,
        study.questionNodeId,
      ]);
    });

    it('caps a study at 1,000 live notes with 422 NOTE_LIMIT_EXCEEDED: trashed notes do not count, and a restore needs room', async () => {
      const study = await createStudy(alice);
      const limitEnvelope = envelope({
        code: 'NOTE_LIMIT_EXCEEDED',
        message: 'A study can have at most 1,000 notes outside the note trash',
      });
      const fill = (trashed: boolean) =>
        db.query(
          `INSERT INTO note (study_id, owner_id, rich_text_json, plain_text, search_text, deleted_at)
           SELECT $1, $2, '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, '', '',
                  CASE WHEN $3::boolean THEN now() END
             FROM generate_series(1, 999)`,
          { bind: [study.studyId, alice.user.id, trashed], type: QueryTypes.INSERT },
        );
      // 999 notes in the note trash and 999 live: the 1,000th live note is still allowed.
      await fill(true);
      await fill(false);
      const last = await createNote(alice, study.studyId, doc('the thousandth'));
      const before = await ownerRows(alice);
      const refused = await send(alice, 'post', notesPath(study.studyId), {
        expectedRevision: await studyRevision(study.studyId),
        content: doc('one too many'),
      });
      expect([refused.status, refused.body]).toStrictEqual([422, limitEnvelope]);
      expect(await ownerRows(alice)).toStrictEqual(before);

      // Trashing one makes room; restoring one while 1,000 are live is refused, writing nothing.
      const trashed = await send(alice, 'delete', notePath(study.studyId, last.id), {
        expectedRevision: 1,
      });
      expect(trashed.status).toBe(200);
      const filler = await createNote(alice, study.studyId, doc('room again'));
      const restoreBefore = await ownerRows(alice);
      const restore = await send(alice, 'post', `${notePath(study.studyId, last.id)}/restore`, {
        expectedRevision: 2,
      });
      expect([restore.status, restore.body]).toStrictEqual([422, limitEnvelope]);
      expect(await ownerRows(alice)).toStrictEqual(restoreBefore);
      await send(alice, 'delete', notePath(study.studyId, filler.id), { expectedRevision: 1 });
      const restored = await send(alice, 'post', `${notePath(study.studyId, last.id)}/restore`, {
        expectedRevision: 2,
      });
      expect(restored.status).toBe(200);
      await Note.destroy({ where: { studyId: study.studyId } });
    });
  });

  describe('library search over notes', () => {
    it("finds studies by live note text, says so, and never matches trashed notes or another user's notes", async () => {
      const dana = await signedInUser();
      const word = `w${randomUUID().slice(0, 8)}`;
      const inNote = await createStudy(dana, { title: 'Plain title', blank: true });
      const note = await createNote(
        dana,
        inNote.studyId,
        doc(`About ${word.toUpperCase()} 100%_done`),
      );
      const inTitle = await createStudy(dana, { title: `Title ${word}`, blank: true });
      // Bob's note has the same word: never Dana's result.
      const bobs = await createStudy(bob, { blank: true });
      await createNote(bob, bobs.studyId, doc(word));

      const search = async (owner: Owner, q: string) => {
        const res = await request(app.getHttpServer())
          .get(STUDIES)
          .query({ q, sort: 'created' })
          .set('Cookie', owner.cookie)
          .expect(200);
        return (res.body as StudyListResponse).items.map((item) => [item.id, item.matchedInNotes]);
      };
      expect(await search(dana, word)).toStrictEqual([
        [inTitle.studyId, false],
        [inNote.studyId, true],
      ]);
      // Literal characters, every word must match somewhere.
      expect(await search(dana, `${word} 100%_done`)).toStrictEqual([[inNote.studyId, true]]);
      expect(await search(dana, `${word} 100%x`)).toStrictEqual([]);
      // Without a search nothing is "found in notes".
      const all = await request(app.getHttpServer())
        .get(STUDIES)
        .set('Cookie', dana.cookie)
        .expect(200);
      expect(
        (all.body as StudyListResponse).items.map((item) => item.matchedInNotes),
      ).toStrictEqual([false, false]);
      // A trashed note is not searched.
      await send(dana, 'delete', notePath(inNote.studyId, note.id), { expectedRevision: 1 });
      expect(await search(dana, word)).toStrictEqual([[inTitle.studyId, false]]);
    });
  });

  describe('owner isolation', () => {
    /**
     * Bob calls a note route on Alice's study and note, on an absent note, on a malformed id, on
     * Alice's note under his own study, and without a session. Returns every answer plus whether
     * either owner's rows changed, for one whole-body assertion.
     */
    async function crossUserAnswers(
      method: 'get' | 'post' | 'patch' | 'delete',
      path: (ids: { studyId: string; noteId: string; versionId: string }) => string,
      body?: object,
    ) {
      const study = await createStudy(alice);
      const note = await createNote(alice, study.studyId, doc('Alice private note'));
      const version = await NoteVersion.findOne({
        where: { noteId: note.id },
        rejectOnEmpty: true,
      });
      const bobsStudy = await createStudy(bob);
      if (method === 'post' && path(ids(study.studyId, note.id, version.id)).endsWith('/restore')) {
        await send(alice, 'delete', notePath(study.studyId, note.id), { expectedRevision: 1 });
      }
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const answers = [
        await send(bob, method, path(ids(study.studyId, note.id, version.id)), body),
        await send(bob, method, path(ids(study.studyId, randomUUID(), randomUUID())), body),
        await send(bob, method, path(ids(study.studyId, 'not-a-uuid', 'not-a-uuid')), body),
        await send(bob, method, path(ids(bobsStudy.studyId, note.id, version.id)), body),
        await send(null, method, path(ids(study.studyId, note.id, version.id)), body),
      ];
      return {
        answers: answers.map((res): unknown[] => [res.status, res.body]),
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), aliceBefore),
        bobUnchanged: isDeepStrictEqual(await ownerRows(bob), bobBefore),
      };
    }

    const ids = (studyId: string, noteId: string, versionId: string) => ({
      studyId,
      noteId,
      versionId,
    });

    /** For collection routes Bob's own study legitimately answers (empty list, 201, ...). */
    const CROSS_USER_ANSWERS = {
      answers: [
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [401, UNAUTHENTICATED],
      ],
      aliceUnchanged: true,
      bobUnchanged: true,
    };

    it('POST /v1/studies/:studyId/notes gives another user the same neutral 404 as an absent or malformed study, writing nothing', async () => {
      const study = await createStudy(alice);
      const before = await ownerRows(alice);
      const answers = [
        await send(bob, 'post', notesPath(study.studyId), {
          expectedRevision: 1,
          content: doc('x'),
        }),
        await send(bob, 'post', notesPath(randomUUID()), {
          expectedRevision: 1,
          content: doc('x'),
        }),
        await send(bob, 'post', notesPath('not-a-uuid'), {
          expectedRevision: 1,
          content: doc('x'),
        }),
        // Bob's own study, but Alice's node as the target: not his study's node.
        await send(bob, 'post', notesPath((await createStudy(bob)).studyId), {
          expectedRevision: 1,
          content: doc('x'),
          targetNodeId: study.questionNodeId,
        }),
        await send(null, 'post', notesPath(study.studyId), {
          expectedRevision: 1,
          content: doc('x'),
        }),
      ].map((res): unknown[] => [res.status, res.body]);
      expect({
        answers,
        aliceUnchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: [
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [404, NOT_FOUND],
          [422, TARGET_NOT_FOUND],
          [401, UNAUTHENTICATED],
        ],
        aliceUnchanged: true,
      });
    });

    it("GET /v1/studies/:studyId/notes lists nothing of another user's: their study is the same 404 as an absent one", async () => {
      const study = await createStudy(alice);
      await createNote(alice, study.studyId, doc('Alice private note'));
      const bobsStudy = await createStudy(bob);
      const answers = [
        await send(bob, 'get', notesPath(study.studyId)),
        await send(bob, 'get', notesPath(randomUUID())),
        await send(bob, 'get', notesPath('not-a-uuid')),
        await send(bob, 'get', notesPath(bobsStudy.studyId)),
        await send(null, 'get', notesPath(study.studyId)),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(answers).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [200, { items: [] }],
        [401, UNAUTHENTICATED],
      ]);
    });

    it('GET /v1/studies/:studyId/notes/:noteId gives another user the same neutral 404 as an absent or malformed id', async () => {
      expect(
        await crossUserAnswers('get', ({ studyId, noteId }) => notePath(studyId, noteId)),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('PATCH /v1/studies/:studyId/notes/:noteId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('patch', ({ studyId, noteId }) => notePath(studyId, noteId), {
          expectedRevision: 1,
          content: doc('Bob was here'),
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('DELETE /v1/studies/:studyId/notes/:noteId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('delete', ({ studyId, noteId }) => notePath(studyId, noteId), {
          expectedRevision: 1,
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('POST /v1/studies/:studyId/notes/:noteId/restore gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('post', ({ studyId, noteId }) => noteRestorePath(studyId, noteId), {
          expectedRevision: 2,
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('GET /v1/studies/:studyId/notes/:noteId/versions gives another user the same neutral 404 as an absent or malformed id', async () => {
      expect(
        await crossUserAnswers('get', ({ studyId, noteId }) => noteVersionsPath(studyId, noteId)),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('GET /v1/studies/:studyId/notes/:noteId/versions/:versionId gives another user the same neutral 404 as an absent or malformed id', async () => {
      expect(
        await crossUserAnswers('get', ({ studyId, noteId, versionId }) =>
          noteVersionPath(studyId, noteId, versionId),
        ),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });
});
