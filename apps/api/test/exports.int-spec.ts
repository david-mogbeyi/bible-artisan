import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  accountExportDocumentSchema,
  type CreateEdgeResponse,
  type CreateNodeResponse,
  type CreateStudyResponse,
  type ExportResponse,
  type ResolveReferenceResponse,
  type ScriptureReference,
  studyExportDocumentSchema,
} from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cursorSecret, type Env } from '../src/config/env';
import { ENV } from '../src/config/config.module';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { ExportFile } from '../src/database/models/export-file.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { ExportPurgeService } from '../src/modules/exports/export-purge.service';
import { exportLinkKey, signExportLink } from '../src/modules/exports/download-link';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

interface Owner {
  user: User;
  cookie: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const anyTime: unknown = expect.stringMatching(ISO);

const STUDIES = '/v1/studies';
// Literal `/v1/…` templates: the route inventory finds a cross-user test's path through them.
const studyExportsPath = (studyId: string): string => `/v1/studies/${studyId}/exports`;
const exportPath = (exportId: string): string => `/v1/exports/${exportId}`;
const downloadPath = (exportId: string, query: string): string =>
  `/v1/exports/${exportId}/download?${query}`;
const ACCOUNT_EXPORTS = '/v1/me/exports';

const LINK_EXPIRED = envelope({
  code: 'EXPORT_LINK_EXPIRED',
  message: 'This download link has expired. Request a new one',
});

/** The whole create/status response, for a fresh export of `studyId` (null: account). */
const exportBody = (
  kind: 'study' | 'account',
  studyId: string | null,
  format: 'json' | 'markdown',
): Record<string, unknown> => ({
  id: expect.stringMatching(UUID),
  kind,
  studyId,
  format,
  status: 'ready',
  fileName: expect.stringMatching(
    new RegExp(
      `^bible-artisan-${kind === 'study' ? 'study-[0-9a-f]{8}' : 'account'}-\\d{4}-\\d{2}-\\d{2}\\.${format === 'json' ? 'json' : 'md'}$`,
    ),
  ),
  byteSize: expect.any(Number),
  createdAt: anyTime,
  expiresAt: anyTime,
  downloadUrl: expect.stringMatching(
    /^\/v1\/exports\/[0-9a-f-]{36}\/download\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/,
  ),
  downloadUrlExpiresAt: anyTime,
});

/** BIB-47 (study exports) and BIB-48 (account export). */
describe('study and account exports (BIB-47, BIB-48)', () => {
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
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path);
    if (owner) req = req.set('Cookie', owner.cookie);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  async function reference(input: string): Promise<ScriptureReference> {
    const res = await send(alice, 'post', '/v1/bible/resolve', { input, editionId });
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  const revisionOf = async (studyId: string): Promise<number> =>
    (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;

  async function createNode(owner: Owner, studyId: string, body: object): Promise<string> {
    const res = await send(owner, 'post', `${STUDIES}/${studyId}/nodes`, {
      expectedRevision: await revisionOf(studyId),
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  /** A study with a starting passage, an observation supporting a conclusion, and a note. */
  async function richStudy(owner: Owner) {
    const romans = await reference('Romans 9:1');
    const created = await send(owner, 'post', STUDIES, {
      startingReferenceId: romans.id,
      question: 'What does conscience witness?',
    });
    expect(created.status).toBe(201);
    const { studyId } = created.body as CreateStudyResponse;
    const observation = await createNode(owner, studyId, {
      type: 'observation',
      text: 'Paul appeals to his conscience',
      observationKind: 'textual_observation',
    });
    const conclusion = await createNode(owner, studyId, {
      type: 'conclusion',
      text: 'Conscience is a moral witness',
    });
    const edge = await send(owner, 'post', `${STUDIES}/${studyId}/edges`, {
      expectedRevision: await revisionOf(studyId),
      sourceNodeId: observation,
      targetNodeId: conclusion,
      type: 'supports',
    });
    expect(edge.status).toBe(201);
    const supported = await send(owner, 'patch', `${STUDIES}/${studyId}/nodes/${conclusion}`, {
      expectedRevision: (await StudyNode.findByPk(conclusion, { rejectOnEmpty: true })).revision,
      status: 'supported',
    });
    expect(supported.status).toBe(200);
    const note = await send(owner, 'post', `${STUDIES}/${studyId}/notes`, {
      expectedRevision: await revisionOf(studyId),
      targetNodeId: observation,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Compare 2 Cor 1:12' }] }],
      },
    });
    expect(note.status).toBe(201);
    return {
      studyId,
      romans,
      observation,
      conclusion,
      edgeId: (edge.body as CreateEdgeResponse).id,
    };
  }

  async function exportOf(owner: Owner, path: string, format: 'json' | 'markdown') {
    const res = await send(owner, 'post', path, { format });
    expect(res.status).toBe(201);
    return res.body as ExportResponse;
  }

  async function downloaded(owner: Owner, created: ExportResponse): Promise<Response> {
    const res = await send(owner, 'get', created.downloadUrl);
    expect(res.status).toBe(200);
    return res;
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
    await User.destroy({ where: { id: userIds } }); // cascades to studies, sessions, exports
    await app.close();
  });

  it('exports an owned study as versioned JSON with its full provenance, Scripture text and history', async () => {
    const { studyId, romans, observation, conclusion, edgeId } = await richStudy(alice);
    const revisionBefore = await revisionOf(studyId);

    const created = await exportOf(alice, studyExportsPath(studyId), 'json');
    expect(created).toStrictEqual(exportBody('study', studyId, 'json'));
    const file = await downloaded(alice, created);
    expect(file.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${created.fileName}"`);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(Number(file.headers['content-length'])).toBe(created.byteSize);

    // Round trip: the file parses with the versioned schema.
    const document = studyExportDocumentSchema.parse(JSON.parse(file.text));
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
    expect(document.schema).toBe('bible-artisan.study-export');
    expect(document.schemaVersion).toBe(1);
    expect(document.basis).toStrictEqual({
      revision: study.revision,
      contentRevision: study.contentRevision,
      lastEventSequence: study.lastEventSequence,
    });
    expect(document.summary).toBeNull();
    // Exporting changes nothing about the study.
    expect(study.revision).toBe(revisionBefore);

    const verse = await BibleVerse.findOne({
      where: { editionId, bookCode: 'ROM', chapter: 9, verse: 1 },
      rejectOnEmpty: true,
    });
    expect(document.scripture).toStrictEqual([
      {
        referenceId: romans.id,
        label: romans.label,
        bookCode: 'ROM',
        startChapter: 9,
        startVerse: 1,
        endChapter: 9,
        endVerse: 1,
        edition: {
          id: editionId,
          abbreviation: expect.any(String),
          name: expect.any(String),
          attribution: expect.stringContaining('public domain'),
          noticeUrl: expect.stringMatching(/^https:\/\//),
        },
        text: [{ chapter: 9, verse: 1, text: verse.text }],
        textOmitted: null,
      },
    ]);
    expect(document.nodes.map((node) => node.type).sort()).toStrictEqual([
      'conclusion',
      'observation',
      'question',
      'scripture',
    ]);
    expect(document.edges).toStrictEqual([
      expect.objectContaining({
        id: edgeId,
        sourceNodeId: observation,
        targetNodeId: conclusion,
        type: 'supports',
        deletedAt: null,
      }),
    ]);
    expect(document.conclusionVersions).toStrictEqual([
      expect.objectContaining({
        nodeId: conclusion,
        versionNumber: 1,
        action: 'created',
        conclusionStatus: 'tentative',
        statement: 'Conscience is a moral witness',
        evidence: [],
      }),
      expect.objectContaining({
        nodeId: conclusion,
        versionNumber: 2,
        conclusionStatus: 'supported',
        evidence: [expect.objectContaining({ edgeId, role: 'supporting', nodeId: observation })],
      }),
    ]);
    expect(document.notes).toStrictEqual([
      expect.objectContaining({
        targetNodeId: observation,
        plainText: 'Compare 2 Cor 1:12',
        versions: [expect.objectContaining({ versionNumber: 1, plainText: 'Compare 2 Cor 1:12' })],
      }),
    ]);
    // Every Study Thread event, in order, up to the basis.
    expect(document.events.map((event) => event.sequence)).toStrictEqual(
      Array.from({ length: Number(study.lastEventSequence) }, (_, i) => String(i + 1)),
    );
    expect(document.events[0]?.eventType).toBe('study_created');
  });

  it('exports readable Markdown with Scripture attribution, statuses, links and unavailable-evidence labels', async () => {
    const { studyId, edgeId } = await richStudy(alice);
    // Remove the supporting relationship: the conclusion's version keeps it as evidence that is
    // no longer available.
    const edge = await StudyEdge.findByPk(edgeId, { rejectOnEmpty: true });
    const removed = await send(alice, 'delete', `${STUDIES}/${studyId}/edges/${edgeId}`, {
      expectedRevision: edge.revision,
    });
    expect(removed.status).toBe(200);

    const created = await exportOf(alice, studyExportsPath(studyId), 'markdown');
    expect(created).toStrictEqual(exportBody('study', studyId, 'markdown'));
    const file = await downloaded(alice, created);
    expect(file.headers['content-type']).toBe('text/markdown; charset=utf-8');
    const markdown = file.text;
    expect(markdown).toContain('# What does conscience witness?');
    expect(markdown).toContain('## Scripture');
    expect(markdown).toMatch(/### Romans 9:1 \(\w+\)/);
    expect(markdown).toContain('public domain');
    expect(markdown).toContain('### What does conscience witness? (status: open)');
    expect(markdown).toContain('(status: supported)');
    expect(markdown).toContain(
      'Supporting evidence (supports): Paul appeals to his conscience [evidence unavailable]',
    );
    expect(markdown).toContain('> Compare 2 Cor 1:12');
    expect(markdown).toContain('## Study Thread');
    expect(markdown).toContain('1. ');
  });

  it('exports the account with its profile and every study, and only its own', async () => {
    const { studyId } = await richStudy(alice);
    const bobsOwn = await send(bob, 'post', STUDIES, { blank: true });
    expect(bobsOwn.status).toBe(201);

    const created = await exportOf(alice, ACCOUNT_EXPORTS, 'json');
    expect(created).toStrictEqual(exportBody('account', null, 'json'));
    const document = accountExportDocumentSchema.parse(
      JSON.parse((await downloaded(alice, created)).text),
    );
    expect(document.account).toStrictEqual({
      id: alice.user.id,
      email: alice.user.normalizedEmail,
      displayName: null,
      timezone: 'UTC',
      createdAt: anyTime,
    });
    const aliceStudies = await Study.findAll({ where: { ownerId: alice.user.id } });
    expect(document.studies.map((study) => study.study.id).sort()).toStrictEqual(
      aliceStudies.map((study) => study.id).sort(),
    );
    expect(document.studies.map((study) => study.study.id)).toContain(studyId);
    expect(document.studies.map((study) => study.study.id)).not.toContain(
      (bobsOwn.body as CreateStudyResponse).studyId,
    );

    const markdown = await exportOf(bob, ACCOUNT_EXPORTS, 'markdown');
    expect(markdown).toStrictEqual(exportBody('account', null, 'markdown'));
    const text = (await downloaded(bob, markdown)).text;
    expect(text).toContain('# Bible Artisan account export');
    expect(text).not.toContain('What does conscience witness?');
  });

  it('POST /v1/studies/:studyId/exports, GET /v1/exports/:exportId and its download give another user the same neutral 404 as an absent or malformed id', async () => {
    const { studyId } = await richStudy(alice);
    const created = await exportOf(alice, studyExportsPath(studyId), 'json');
    const query = created.downloadUrl.split('?')[1] ?? '';

    const responses = [
      await send(bob, 'post', studyExportsPath(studyId), { format: 'json' }),
      await send(bob, 'post', studyExportsPath(randomUUID()), { format: 'json' }),
      await send(bob, 'post', studyExportsPath('not-a-uuid'), { format: 'json' }),
      await send(bob, 'get', exportPath(created.id)),
      await send(bob, 'get', exportPath(randomUUID())),
      await send(bob, 'get', exportPath('not-a-uuid')),
      // Alice's own signed link, presented with Bob's session.
      await send(bob, 'get', downloadPath(created.id, query)),
      // A link signed for another export.
      await send(alice, 'get', downloadPath(randomUUID(), query)),
    ];
    expect(responses.map((res): unknown[] => [res.status, res.body as unknown])).toStrictEqual(
      responses.map(() => [404, NOT_FOUND]),
    );
    expect(await ExportFile.count({ where: { ownerId: bob.user.id, studyId } })).toBe(0);

    const anonymous = [
      await send(null, 'post', studyExportsPath(studyId), { format: 'json' }),
      await send(null, 'post', ACCOUNT_EXPORTS, { format: 'json' }),
      await send(null, 'get', exportPath(created.id)),
      await send(null, 'get', created.downloadUrl),
    ];
    expect(anonymous.map((res): unknown[] => [res.status, res.body as unknown])).toStrictEqual(
      anonymous.map(() => [401, UNAUTHENTICATED]),
    );

    // The owner still gets it, with a fresh link.
    const status = await send(alice, 'get', exportPath(created.id));
    expect([status.status, status.body]).toStrictEqual([
      200,
      { ...exportBody('study', studyId, 'json'), id: created.id },
    ]);
  });

  it('refuses an unknown format, an expired link and an expired export', async () => {
    const { studyId } = await richStudy(alice);
    const invalid = await send(alice, 'post', studyExportsPath(studyId), { format: 'pdf' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toStrictEqual(
      envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { format: [expect.any(String)] },
      }),
    );

    const created = await exportOf(alice, studyExportsPath(studyId), 'json');
    // A correctly signed link whose 15 minutes are over.
    const key = exportLinkKey(cursorSecret(app.get<Env>(ENV)));
    const past = Math.floor(Date.now() / 1000) - 1;
    const signature = signExportLink(key, created.id, alice.user.id, past);
    const expired = await send(
      alice,
      'get',
      downloadPath(created.id, `expires=${past}&signature=${signature}`),
    );
    expect([expired.status, expired.body]).toStrictEqual([422, LINK_EXPIRED]);
    // A link with a tampered expiry fails its signature: the neutral 404.
    const tampered = await send(
      alice,
      'get',
      downloadPath(created.id, `expires=${past + 3600}&signature=${signature}`),
    );
    expect([tampered.status, tampered.body]).toStrictEqual([404, NOT_FOUND]);

    // Past its 24 hours the export is absent, and the purge removes it.
    await db.query(
      `UPDATE export_file SET created_at = now() - interval '25 hours',
                              expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      { bind: [created.id] },
    );
    const gone = [
      await send(alice, 'get', exportPath(created.id)),
      await send(alice, 'get', created.downloadUrl),
    ];
    expect(gone.map((res): unknown[] => [res.status, res.body as unknown])).toStrictEqual([
      [404, NOT_FOUND],
      [404, NOT_FOUND],
    ]);
    expect(await new ExportPurgeService().purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await ExportFile.findByPk(created.id)).toBeNull();
  });
});
