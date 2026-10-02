import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import {
  type AnchorSelection,
  type CaptureAnchorResponse,
  type CreateAnnotationResponse,
  type CreateStudyResponse,
  MAX_ANNOTATIONS_PER_STUDY,
  type ResolveReferenceResponse,
  type ScriptureAnchor,
  type ScriptureReference,
} from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { Annotation } from '../src/database/models/annotation.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEvent } from '../src/database/models/study-event.model';
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
const annotationsPath = (studyId: string): string => `/v1/studies/${studyId}/annotations`;
const annotationPath = (studyId: string, annotationId: string): string =>
  `/v1/studies/${studyId}/annotations/${annotationId}`;
const listPath = (studyId: string, referenceId: string): string =>
  `${annotationsPath(studyId)}?${new URLSearchParams({ referenceId }).toString()}`;

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
const UNCHANGED = envelope({
  code: 'ANNOTATION_UNCHANGED',
  message: 'The highlight already has this color and label',
});
const LIMIT = envelope({
  code: 'ANNOTATION_LIMIT_EXCEEDED',
  message: 'A study can have at most 2,000 highlights',
});
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
const anchorProblem = (code: string, message: string) => envelope({ code, message });

/**
 * BIB-24: highlights (`/v1/studies/:studyId/annotations`) against the real imported WEB corpus.
 * No Scripture is typed: quotes are read from the stored verses and anchors are built by
 * `POST /bible/anchors`, exactly as the reader does.
 */
describe('highlights (BIB-24)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let alice: Owner;
  let bob: Owner;
  let editionId: string;
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

  async function createStudy(owner: Owner): Promise<CreateStudyResponse> {
    const res = await send(owner, 'post', STUDIES, { question: 'Who bears witness?' });
    expect(res.status).toBe(201);
    return res.body as CreateStudyResponse;
  }

  const study = async (studyId: string) => Study.findByPk(studyId, { rejectOnEmpty: true });

  async function reference(input: string): Promise<ScriptureReference> {
    const res = await send(alice, 'post', '/v1/bible/resolve', { input, editionId });
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  async function verseText(bookCode: string, chapter: number, verse: number): Promise<string> {
    const row = await BibleVerse.findOne({
      where: { editionId, bookCode, chapter, verse },
      rejectOnEmpty: true,
    });
    return row.text;
  }

  /** Captures an anchor through `POST /bible/anchors`, as the reader does. */
  async function capture(selection: AnchorSelection): Promise<CaptureAnchorResponse> {
    const res = await send(alice, 'post', '/v1/bible/anchors', selection);
    expect(res.status).toBe(200);
    return res.body as CaptureAnchorResponse;
  }

  /** The first `words` words of Romans 9:1 as a phrase anchor. */
  async function phrase(words = 3): Promise<CaptureAnchorResponse> {
    const text = await verseText('ROM', 9, 1);
    const quote = text.split(' ').slice(0, words).join(' ');
    return capture({
      editionId,
      bookCode: 'ROM',
      kind: 'phrase',
      segments: [{ chapter: 9, verse: 1, start: 0, end: Array.from(quote).length }],
      quote,
    });
  }

  /** Whole verses Romans 8:39 through 9:1 (across the chapter boundary). */
  async function acrossChapters(): Promise<CaptureAnchorResponse> {
    const last = await verseText('ROM', 8, 39);
    const first = await verseText('ROM', 9, 1);
    return capture({
      editionId,
      bookCode: 'ROM',
      kind: 'verses',
      segments: [
        { chapter: 8, verse: 39, start: 0, end: Array.from(last).length },
        { chapter: 9, verse: 1, start: 0, end: Array.from(first).length },
      ],
      quote: `${last} ${first}`,
    });
  }

  async function highlight(
    owner: Owner,
    studyId: string,
    anchor: ScriptureAnchor,
    extra: object = {},
  ): Promise<CreateAnnotationResponse> {
    const res = await send(owner, 'post', annotationsPath(studyId), {
      expectedRevision: (await study(studyId)).revision,
      anchor,
      colorToken: 'yellow',
      ...extra,
    });
    expect([res.status, res.body]).toStrictEqual([201, expect.any(Object)]);
    return res.body as CreateAnnotationResponse;
  }

  async function events(studyId: string) {
    const rows = await StudyEvent.findAll({ where: { studyId }, order: [['sequence', 'ASC']] });
    return rows.map((e) => ({ eventType: e.eventType, payload: e.payloadJson }));
  }

  /** Every row a highlight mutation of this owner may write, to prove a refusal wrote nothing. */
  async function ownerRows(owner: Owner) {
    const where = { ownerId: owner.user.id };
    return {
      studies: await Study.findAll({
        where,
        attributes: ['id', 'revision', 'contentRevision', 'lastEventSequence'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      annotations: await Annotation.findAll({
        where,
        attributes: ['id', 'revision', 'colorToken', 'label', 'deletedAt'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      events: await StudyEvent.count({ where }),
      receipts: await MutationReceipt.count({ where }),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    const edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    editionId = edition.id;
    alice = await signedInUser();
    bob = await signedInUser();
  });

  afterAll(async () => {
    // Deleting a user cascades to studies, and each study to its highlights.
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('create and read', () => {
    it('saves a phrase highlight with the anchor exactly as captured, and a reload of its chapter returns it resolved', async () => {
      const { studyId } = await createStudy(alice);
      const before = await study(studyId);
      const { anchor, reference: ref } = await phrase();

      const created = await send(alice, 'post', annotationsPath(studyId), {
        expectedRevision: 1,
        anchor,
        colorToken: 'green',
        label: '  Witness  ',
      });
      expect([created.status, created.body]).toStrictEqual([
        201,
        {
          id: anyId,
          studyId,
          revision: 1,
          colorToken: 'green',
          referenceId: ref.id,
          createdAt: anyTime,
          updatedAt: anyTime,
          deletedAt: null,
          lastEventSequence: '2',
          studyRevision: 2,
        },
      ]);
      const body = created.body as CreateAnnotationResponse;

      // Stored exactly as captured (checksums included); columns derived from it.
      const row = await Annotation.findByPk(body.id, { rejectOnEmpty: true, raw: true });
      expect(row).toMatchObject({
        anchorJson: anchor,
        editionId,
        bookCode: 'ROM',
        startChapter: 9,
        endChapter: 9,
        label: 'Witness',
      });

      const chapter = await reference('Romans 9');
      const list = await send(alice, 'get', listPath(studyId, chapter.id));
      expect([list.status, list.body]).toStrictEqual([
        200,
        {
          items: [
            {
              id: body.id,
              revision: 1,
              colorToken: 'green',
              label: 'Witness',
              resolution: { outcome: 'resolved', anchor, reference: ref },
              createdAt: body.createdAt,
              updatedAt: body.updatedAt,
            },
          ],
        },
      ]);
      expect(list.headers['cache-control']).toBe('no-store');

      // One thread-visible event, ids and enums only; a study change and study content.
      expect((await events(studyId)).slice(1)).toStrictEqual([
        {
          eventType: 'highlight_created',
          payload: { annotationId: body.id, referenceId: ref.id, colorToken: 'green' },
        },
      ]);
      const after = await study(studyId);
      expect([after.revision, after.contentRevision]).toStrictEqual([
        before.revision + 1,
        before.contentRevision + 1,
      ]);
    });

    it('refuses an anchor that does not match the corpus with 422 and its code, writing nothing', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor } = await phrase();
      const [segment] = anchor.segments;
      if (!segment) throw new Error('no segment');
      const tampered: [ScriptureAnchor, unknown][] = [
        [
          { ...anchor, segments: [{ ...segment, textSha256: '0'.repeat(64) }] },
          anchorProblem(
            'ANCHOR_CHECKSUM_MISMATCH',
            'The verse text has changed since this selection was made',
          ),
        ],
        [
          { ...anchor, quote: `${anchor.quote}x` },
          anchorProblem(
            'ANCHOR_QUOTE_MISMATCH',
            'The selected text does not match this translation',
          ),
        ],
        [
          { ...anchor, segments: [{ ...segment, end: 1999 }] },
          anchorProblem('ANCHOR_OFFSET_OUT_OF_RANGE', 'The selection runs past the end of a verse'),
        ],
        [
          { ...anchor, kind: 'verses' },
          anchorProblem('ANCHOR_KIND_MISMATCH', 'A verse selection must cover whole verses'),
        ],
        [
          { ...anchor, editionId: randomUUID() },
          anchorProblem('ANCHOR_EDITION_UNAVAILABLE', 'That translation is not available'),
        ],
      ];
      const before = await ownerRows(alice);
      const answers = [];
      for (const [bad] of tampered) {
        const res = await send(alice, 'post', annotationsPath(studyId), {
          expectedRevision: 1,
          anchor: bad,
          colorToken: 'yellow',
        });
        answers.push([res.status, res.body]);
      }
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({
        answers: tampered.map(([, body]) => [422, body]),
        unchanged: true,
      });
    });

    it('lists a stored anchor that no longer matches as unresolved with its original quote, never moved', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor, reference: ref } = await phrase();
      const created = await highlight(alice, studyId, anchor);
      // The stored anchor drifts from the corpus (it can't through the API): its quote changes.
      const drifted = { ...anchor, quote: `${anchor.quote} (as remembered)` };
      await db.query('UPDATE annotation SET anchor_json = $2 WHERE id = $1', {
        bind: [created.id, JSON.stringify(drifted)],
        type: QueryTypes.UPDATE,
      });
      const list = await send(alice, 'get', listPath(studyId, (await reference('Romans 9')).id));
      expect([list.status, list.body]).toStrictEqual([
        200,
        {
          items: [
            {
              id: created.id,
              revision: 1,
              colorToken: 'yellow',
              label: null,
              resolution: {
                outcome: 'unresolved',
                reason: 'ANCHOR_QUOTE_MISMATCH',
                anchor: drifted,
                reference: ref,
              },
              createdAt: created.createdAt,
              updatedAt: created.updatedAt,
            },
          ],
        },
      ]);
    });

    it("lists the highlights touching the reader's chapter: a highlight across chapters appears in both, never in another chapter, book or study", async () => {
      const { studyId } = await createStudy(alice);
      const other = await createStudy(alice);
      const across = await highlight(alice, studyId, (await acrossChapters()).anchor);
      const onPhrase = await highlight(alice, studyId, (await phrase()).anchor, {
        colorToken: 'pink',
      });
      await highlight(alice, other.studyId, (await phrase()).anchor);
      const ids = async (input: string) => {
        const res = await send(alice, 'get', listPath(studyId, (await reference(input)).id));
        expect(res.status).toBe(200);
        return (res.body as { items: { id: string }[] }).items.map((item) => item.id);
      };
      expect({
        romans8: await ids('Romans 8'),
        romans9: await ids('Romans 9'),
        // A verse reference lists its whole chapter (the chapter the reader shows).
        romans9verse5: await ids('Romans 9:5'),
        romans10: await ids('Romans 10'),
        john1: await ids('John 1'),
      }).toStrictEqual({
        romans8: [across.id],
        romans9: [across.id, onPhrase.id],
        romans9verse5: [across.id, onPhrase.id],
        romans10: [],
        john1: [],
      });
    });

    it('answers 400 for a missing or malformed referenceId and 404 for an unknown one', async () => {
      const { studyId } = await createStudy(alice);
      const answers = [
        await send(alice, 'get', annotationsPath(studyId)),
        await send(alice, 'get', `${annotationsPath(studyId)}?referenceId=Romans%209`),
        await send(alice, 'get', listPath(studyId, randomUUID())),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(answers).toStrictEqual([
        [400, INVALID],
        [400, INVALID],
        [404, NOT_FOUND],
      ]);
    });

    it('validates color, label and fields with 400, and stores a blank label as none', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor } = await phrase();
      const before = await ownerRows(alice);
      const refused = [
        { colorToken: 'red' },
        { colorToken: 'yellow', label: 'x'.repeat(81) },
        { colorToken: 'yellow', label: 'line\nbreak' },
        { colorToken: 'yellow', ownerId: bob.user.id },
        { colorToken: 'yellow', anchor: { ...anchor, segments: [] } },
      ];
      const answers = [];
      for (const extra of refused) {
        const res = await send(alice, 'post', annotationsPath(studyId), {
          expectedRevision: 1,
          anchor,
          ...extra,
        });
        answers.push([res.status, res.body]);
      }
      expect({
        answers,
        unchanged: isDeepStrictEqual(await ownerRows(alice), before),
      }).toStrictEqual({ answers: refused.map(() => [400, INVALID]), unchanged: true });

      // 80 code points (emoji count once) are accepted; whitespace only is no label.
      const emoji = await highlight(alice, studyId, anchor, { label: '🙂'.repeat(80) });
      const blank = await highlight(alice, studyId, anchor, { label: '   ' });
      const rows = await Annotation.findAll({
        where: { id: [emoji.id, blank.id] },
        order: [['createdAt', 'ASC']],
      });
      expect(rows.map((r) => r.label)).toStrictEqual(['🙂'.repeat(80), null]);
    });
  });

  describe('changing and deleting', () => {
    it('changes color and label on the highlight revision without moving content revision: 428, 409, replay, key reuse and unchanged', async () => {
      const { studyId } = await createStudy(alice);
      const created = await highlight(alice, studyId, (await phrase()).anchor);
      const path = annotationPath(studyId, created.id);
      const content = (await study(studyId)).contentRevision;

      const missing = await send(alice, 'patch', path, { colorToken: 'blue' });
      const key = randomUUID();
      const body = { expectedRevision: 1, colorToken: 'blue', label: 'Paul' };
      const changed = await send(alice, 'patch', path, body, key);
      const replay = await send(alice, 'patch', path, body, key);
      const reused = await send(alice, 'patch', path, { ...body, colorToken: 'pink' }, key);
      const stale = await send(alice, 'patch', path, { expectedRevision: 1, colorToken: 'pink' });
      const same = await send(alice, 'patch', path, { expectedRevision: 2, colorToken: 'blue' });
      const cleared = await send(alice, 'patch', path, { expectedRevision: 2, label: '' });

      const expected = {
        id: created.id,
        studyId,
        revision: 2,
        colorToken: 'blue',
        referenceId: created.referenceId,
        createdAt: created.createdAt,
        updatedAt: anyTime,
        deletedAt: null,
        lastEventSequence: '3',
      };
      expect(
        [missing, changed, replay, reused, stale, same, cleared].map((r): unknown[] => [
          r.status,
          r.body,
        ]),
      ).toStrictEqual([
        [428, REVISION_MISSING],
        [200, expected],
        [200, { ...expected, updatedAt: (changed.body as { updatedAt: string }).updatedAt }],
        [422, KEY_REUSED],
        [409, conflict(2)],
        [422, UNCHANGED],
        [200, { ...expected, revision: 3, lastEventSequence: '4' }],
      ]);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const row = await Annotation.findByPk(created.id, { rejectOnEmpty: true });
      expect([row.colorToken, row.label]).toStrictEqual(['blue', null]);
      expect((await events(studyId)).slice(2)).toStrictEqual([
        {
          eventType: 'highlight_updated',
          payload: { annotationId: created.id, colorToken: 'blue' },
        },
        {
          eventType: 'highlight_updated',
          payload: { annotationId: created.id, colorToken: 'blue' },
        },
      ]);
      expect((await study(studyId)).contentRevision).toBe(content);
    });

    it('deletes a highlight: content revision moves, it leaves the list, and is then 404', async () => {
      const { studyId } = await createStudy(alice);
      const created = await highlight(alice, studyId, (await phrase()).anchor);
      const path = annotationPath(studyId, created.id);
      const content = (await study(studyId)).contentRevision;

      const deleted = await send(alice, 'delete', path, { expectedRevision: 1 });
      expect([deleted.status, deleted.body]).toStrictEqual([
        200,
        {
          id: created.id,
          studyId,
          revision: 2,
          colorToken: 'yellow',
          referenceId: created.referenceId,
          createdAt: created.createdAt,
          updatedAt: anyTime,
          deletedAt: anyTime,
          lastEventSequence: '3',
        },
      ]);
      const after = [
        await send(alice, 'delete', path, { expectedRevision: 2 }),
        await send(alice, 'patch', path, { expectedRevision: 2, colorToken: 'blue' }),
        await send(alice, 'get', listPath(studyId, (await reference('Romans 9')).id)),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(after).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [200, { items: [] }],
      ]);
      expect((await events(studyId)).at(-1)).toStrictEqual({
        eventType: 'highlight_deleted',
        payload: { annotationId: created.id },
      });
      expect((await study(studyId)).contentRevision).toBe(content + 1);
    });

    it('refuses every highlight mutation on an archived or trashed study with 422 and writes nothing, while its highlights stay readable', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor } = await phrase();
      const created = await highlight(alice, studyId, anchor);
      const chapter = await reference('Romans 9');
      const attempts = async () => {
        const revision = (await study(studyId)).revision;
        const before = await ownerRows(alice);
        const answers = [
          await send(alice, 'post', annotationsPath(studyId), {
            expectedRevision: revision,
            anchor,
            colorToken: 'blue',
          }),
          await send(alice, 'patch', annotationPath(studyId, created.id), {
            expectedRevision: 1,
            colorToken: 'blue',
          }),
          await send(alice, 'delete', annotationPath(studyId, created.id), {
            expectedRevision: 1,
          }),
        ].map((res): unknown[] => [res.status, res.body]);
        const list = await send(alice, 'get', listPath(studyId, chapter.id));
        return {
          answers,
          unchanged: isDeepStrictEqual(await ownerRows(alice), before),
          listed: (list.body as { items: { id: string }[] }).items.map((item) => item.id),
        };
      };

      const archive = await send(alice, 'post', `${STUDIES}/${studyId}/archive`, {
        expectedRevision: (await study(studyId)).revision,
      });
      expect(archive.status).toBe(200);
      const archived = await attempts();
      const unarchive = await send(alice, 'post', `${STUDIES}/${studyId}/unarchive`, {
        expectedRevision: (await study(studyId)).revision,
      });
      expect(unarchive.status).toBe(200);
      const trash = await send(alice, 'delete', `${STUDIES}/${studyId}`, {
        expectedRevision: (await study(studyId)).revision,
      });
      expect(trash.status).toBe(200);
      const trashed = await attempts();
      expect({ archived, trashed }).toStrictEqual({
        archived: {
          answers: [
            [422, STUDY_ARCHIVED],
            [422, STUDY_ARCHIVED],
            [422, STUDY_ARCHIVED],
          ],
          unchanged: true,
          listed: [created.id],
        },
        trashed: {
          answers: [
            [422, STUDY_TRASHED],
            [422, STUDY_TRASHED],
            [422, STUDY_TRASHED],
          ],
          unchanged: true,
          listed: [created.id],
        },
      });
    });

    it('caps a study at 2,000 live highlights with 422 ANNOTATION_LIMIT_EXCEEDED; deleting one makes room', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor } = await phrase();
      const first = await highlight(alice, studyId, anchor);
      // Fill to the cap directly (copies of the first row), then ask the API for one more.
      await db.query(
        `INSERT INTO annotation (study_id, owner_id, reference_id, edition_id, book_code,
                                 start_chapter, end_chapter, anchor_json, color_token)
         SELECT study_id, owner_id, reference_id, edition_id, book_code, start_chapter,
                end_chapter, anchor_json, color_token
           FROM annotation, generate_series(2, $2) WHERE id = $1`,
        { bind: [first.id, MAX_ANNOTATIONS_PER_STUDY], type: QueryTypes.INSERT },
      );
      const body = () =>
        study(studyId).then((s) => ({ expectedRevision: s.revision, anchor, colorToken: 'blue' }));
      const over = await send(alice, 'post', annotationsPath(studyId), await body());
      await send(alice, 'delete', annotationPath(studyId, first.id), { expectedRevision: 1 });
      const room = await send(alice, 'post', annotationsPath(studyId), await body());
      expect([over.status, over.body, room.status]).toStrictEqual([422, LIMIT, 201]);
    });
  });

  describe('owner isolation', () => {
    /**
     * Bob calls a highlight route on Alice's study and highlight, on an absent highlight, on a
     * malformed id, on Alice's highlight under his own study, and without a session. Returns every
     * answer plus whether either owner's rows changed, for one whole-body assertion.
     */
    async function crossUserAnswers(
      method: 'patch' | 'delete',
      path: (studyId: string, annotationId: string) => string,
      body: object,
    ): Promise<unknown> {
      const { studyId } = await createStudy(alice);
      const created = await highlight(alice, studyId, (await phrase()).anchor, {
        label: 'Alice private label',
      });
      const bobsStudy = await createStudy(bob);
      const aliceBefore = await ownerRows(alice);
      const bobBefore = await ownerRows(bob);
      const answers = [
        await send(bob, method, path(studyId, created.id), body),
        await send(bob, method, path(studyId, randomUUID()), body),
        await send(bob, method, path(studyId, 'not-a-uuid'), body),
        await send(bob, method, path(bobsStudy.studyId, created.id), body),
        await send(null, method, path(studyId, created.id), body),
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
        [401, UNAUTHENTICATED],
      ],
      aliceUnchanged: true,
      bobUnchanged: true,
    };

    it('POST /v1/studies/:studyId/annotations gives another user the same neutral 404 as an absent or malformed study, writing nothing', async () => {
      const { studyId } = await createStudy(alice);
      const { anchor } = await phrase();
      const body = { expectedRevision: 1, anchor, colorToken: 'yellow' };
      const before = await ownerRows(alice);
      const answers = [
        await send(bob, 'post', annotationsPath(studyId), body),
        await send(bob, 'post', annotationsPath(randomUUID()), body),
        await send(bob, 'post', annotationsPath('not-a-uuid'), body),
        await send(null, 'post', annotationsPath(studyId), body),
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

    it("GET /v1/studies/:studyId/annotations lists nothing of another user's: their study is the same 404 as an absent one", async () => {
      const { studyId } = await createStudy(alice);
      await highlight(alice, studyId, (await phrase()).anchor, { label: 'Alice private label' });
      const bobsStudy = await createStudy(bob);
      const chapter = await reference('Romans 9');
      const list = (id: string) => `/v1/studies/${id}/annotations?referenceId=${chapter.id}`;
      const answers = [
        await send(bob, 'get', list(studyId)),
        await send(bob, 'get', list(randomUUID())),
        await send(bob, 'get', list('not-a-uuid')),
        await send(bob, 'get', list(bobsStudy.studyId)),
        await send(null, 'get', list(studyId)),
      ].map((res): unknown[] => [res.status, res.body]);
      expect(answers).toStrictEqual([
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [404, NOT_FOUND],
        [200, { items: [] }],
        [401, UNAUTHENTICATED],
      ]);
    });

    it('PATCH /v1/studies/:studyId/annotations/:annotationId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('patch', annotationPath, {
          expectedRevision: 1,
          colorToken: 'blue',
        }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });

    it('DELETE /v1/studies/:studyId/annotations/:annotationId gives another user the same neutral 404 as an absent or malformed id, writing nothing', async () => {
      expect(
        await crossUserAnswers('delete', annotationPath, { expectedRevision: 1 }),
      ).toStrictEqual(CROSS_USER_ANSWERS);
    });
  });
});
