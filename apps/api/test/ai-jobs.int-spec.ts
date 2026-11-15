import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  AI_CONSENT_VERSION,
  type AiJobAcceptedResponse,
  type CreateStudyResponse,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AiJob } from '../src/database/models/ai-job.model';
import { AiResult } from '../src/database/models/ai-result.model';
import { ContextManifest } from '../src/database/models/context-manifest.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { AiJobRunnerService } from '../src/modules/ai/ai-job-runner.service';
import { AI_PROVIDER, AI_RUNTIME, type AiRuntime } from '../src/modules/ai/provider/ai-provider';
import { FakeAiProvider } from '../src/modules/ai/provider/fake-ai.provider';
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

const RUNTIME: AiRuntime = {
  leaseMs: 120_000,
  heartbeatMs: 25,
  requestBudgetMs: 400,
  retryBaseMs: 1,
  pollMs: 1_000,
  monthlySpendCapMicros: 1_000_000_000,
};

const CONSENT = '/v1/me/ai-consent';
// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const summaryPath = (studyId: string): string => `/v1/studies/${studyId}/ai/summary`;
const settingsPath = (studyId: string): string => `/v1/studies/${studyId}/ai/settings`;
const jobPath = (studyId: string, jobId: string): string =>
  `/v1/studies/${studyId}/ai/jobs/${jobId}`;

const CONSENT_REQUIRED = envelope({
  code: 'AI_CONSENT_REQUIRED',
  message: 'Turn on AI features in your settings to use this',
});

/** BIB-39 + BIB-40: AI consent, the study switch and leased AI jobs. Real PostgreSQL, fake provider. */
describe('AI consent and jobs (BIB-39, BIB-40)', () => {
  let app: INestApplication<Server>;
  let disabledApp: INestApplication<Server>;
  let db: Database;
  let fake: FakeAiProvider;
  let runner: AiJobRunnerService;
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
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: unknown,
    key?: string,
    target: INestApplication<Server> = app,
  ): Promise<Response> {
    let req = request(target.getHttpServer())[method](path);
    if (owner) req = req.set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  const answer = (res: Response): unknown[] => [res.status, res.body];

  async function createStudy(owner: Owner): Promise<string> {
    const res = await send(owner, 'post', '/v1/studies', { question: 'What is conscience?' });
    expect(res.status).toBe(201);
    return (res.body as CreateStudyResponse).studyId;
  }

  async function consentRevision(owner: Owner): Promise<number> {
    return (await User.findByPk(owner.user.id, { rejectOnEmpty: true })).aiSettingsRevision;
  }

  async function consent(owner: Owner, enabled: boolean): Promise<Response> {
    return send(owner, 'put', CONSENT, {
      expectedRevision: await consentRevision(owner),
      enabled,
      ...(enabled ? { consentVersion: AI_CONSENT_VERSION } : {}),
    });
  }

  async function optedIn(): Promise<Owner> {
    const owner = await signedInUser();
    expect((await consent(owner, true)).status).toBe(200);
    return owner;
  }

  async function requested(owner: Owner, studyId: string): Promise<AiJobAcceptedResponse> {
    const res = await send(owner, 'post', summaryPath(studyId));
    expect(res.status).toBe(202);
    return res.body as AiJobAcceptedResponse;
  }

  const job = (id: string) => AiJob.findByPk(id, { rejectOnEmpty: true });

  beforeAll(async () => {
    fake = new FakeAiProvider();
    app = await createTestApp(undefined, {
      override: (builder) =>
        builder
          .overrideProvider(AI_PROVIDER)
          .useValue(fake)
          .overrideProvider(AI_RUNTIME)
          .useValue(RUNTIME),
    });
    disabledApp = await createTestApp(undefined, {
      override: (builder) => builder.overrideProvider(AI_PROVIDER).useValue(null),
    });
    db = app.get<Database>(DATABASE);
    runner = app.get(AiJobRunnerService);
  });

  beforeEach(async () => {
    fake.reset();
    // This suite owns ai_job; other suites never write it (files run serially).
    await db.query('DELETE FROM ai_job');
  });

  afterAll(async () => {
    await User.destroy({ where: { id: userIds } });
    await app.close();
    await disabledApp.close();
  });

  describe('consent (BIB-40)', () => {
    it('GET /v1/me/ai-consent starts off, with no consent recorded and the provider named', async () => {
      const owner = await signedInUser();
      expect(answer(await send(owner, 'get', CONSENT))).toStrictEqual([
        200,
        {
          enabled: false,
          consentVersion: null,
          consentedAt: null,
          currentConsentVersion: AI_CONSENT_VERSION,
          needsRenewal: false,
          revision: 1,
          providerAvailable: true,
          provider: 'Fake (development)',
          modelId: 'fake-model-1',
          remaining: { thisHour: 20, today: 50 },
        },
      ]);
    });

    it('PUT /v1/me/ai-consent turns AI on only with the current consent version, checks the revision, and replays on the same key', async () => {
      const owner = await signedInUser();
      expect(answer(await send(owner, 'put', CONSENT, { enabled: true }))).toStrictEqual([
        428,
        envelope({ code: 'REVISION_MISSING', message: 'expectedRevision is required' }),
      ]);
      expect(
        answer(
          await send(owner, 'put', CONSENT, {
            expectedRevision: 1,
            enabled: true,
            consentVersion: 'old',
          }),
        ),
      ).toStrictEqual([
        422,
        envelope({
          code: 'AI_CONSENT_VERSION_MISMATCH',
          message: 'The AI terms have changed. Review them again to turn AI on',
        }),
      ]);
      const key = randomUUID();
      const body = { expectedRevision: 1, enabled: true, consentVersion: AI_CONSENT_VERSION };
      const first = await send(owner, 'put', CONSENT, body, key);
      expect(answer(first)).toStrictEqual([
        200,
        { enabled: true, consentVersion: AI_CONSENT_VERSION, revision: 2, cancelledJobCount: 0 },
      ]);
      const replay = await send(owner, 'put', CONSENT, body, key);
      expect(answer(replay)).toStrictEqual(answer(first));
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(answer(await send(owner, 'put', CONSENT, body))).toStrictEqual([
        409,
        envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision: 2 }),
      ]);
      const stored = await User.findByPk(owner.user.id, { rejectOnEmpty: true });
      expect([stored.aiEnabled, stored.aiConsentVersion, stored.aiConsentedAt]).toStrictEqual([
        true,
        AI_CONSENT_VERSION,
        expect.any(Date),
      ]);
    });

    it('without an approved provider, AI cannot be turned on or requested, and the settings say so', async () => {
      const owner = await signedInUser();
      const studyId = await createStudy(owner);
      const unavailable = envelope({
        code: 'AI_UNAVAILABLE',
        message: 'AI features are not available right now',
      });
      const status = await send(owner, 'get', CONSENT, undefined, undefined, disabledApp);
      expect((status.body as { providerAvailable: boolean }).providerAvailable).toBe(false);
      expect(
        answer(
          await send(
            owner,
            'put',
            CONSENT,
            { expectedRevision: 1, enabled: true, consentVersion: AI_CONSENT_VERSION },
            undefined,
            disabledApp,
          ),
        ),
      ).toStrictEqual([503, unavailable]);
      expect(
        answer(await send(owner, 'post', summaryPath(studyId), undefined, undefined, disabledApp)),
      ).toStrictEqual([503, unavailable]);
      expect(await AiJob.count({ where: { ownerId: owner.user.id } })).toBe(0);
    });

    it('without consent, a request is refused and nothing reaches the provider (FR-AI-001)', async () => {
      const owner = await signedInUser();
      const studyId = await createStudy(owner);
      expect(answer(await send(owner, 'post', summaryPath(studyId)))).toStrictEqual([
        422,
        CONSENT_REQUIRED,
      ]);
      expect(await runner.runOnce()).toBeNull();
      expect(fake.calls).toBe(0);
    });

    it('revoking consent cancels waiting jobs, which then never call the provider', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      const revoked = await consent(owner, false);
      expect(answer(revoked)).toStrictEqual([
        200,
        { enabled: false, consentVersion: AI_CONSENT_VERSION, revision: 3, cancelledJobCount: 1 },
      ]);
      expect(await runner.runOnce()).toBeNull();
      expect(fake.calls).toBe(0);
      expect([(await job(jobId)).state, (await job(jobId)).errorCode]).toStrictEqual([
        'cancelled',
        'CONSENT_REVOKED',
      ]);
      expect(answer(await send(owner, 'post', summaryPath(studyId)))).toStrictEqual([
        422,
        CONSENT_REQUIRED,
      ]);
    });

    it('revoking consent while the provider is answering discards the output', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      fake.beforeAnswer = async () => {
        expect((await consent(owner, false)).status).toBe(200);
      };
      expect(await runner.runOnce()).toBe(jobId);
      expect(fake.calls).toBe(1);
      const stored = await job(jobId);
      expect([stored.state, stored.errorCode]).toStrictEqual(['cancelled', 'CONSENT_REVOKED']);
      expect(await AiResult.count({ where: { jobId } })).toBe(0);
    });
  });

  describe('study AI switch (BIB-40)', () => {
    it('PUT /v1/studies/:studyId/ai/settings turns AI off for one study, cancels its jobs and leaves its revisions alone', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      const before = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect(answer(await send(owner, 'get', settingsPath(studyId)))).toStrictEqual([
        200,
        { aiEnabled: true, revision: 1 },
      ]);
      expect(
        answer(
          await send(owner, 'put', settingsPath(studyId), {
            expectedRevision: 1,
            aiEnabled: false,
          }),
        ),
      ).toStrictEqual([
        200,
        {
          aiEnabled: false,
          revision: 2,
          cancelledJobCount: 1,
          lastEventSequence: expect.any(String),
        },
      ]);
      const after = await Study.findByPk(studyId, { rejectOnEmpty: true });
      expect([after.revision, after.contentRevision]).toStrictEqual([
        before.revision,
        before.contentRevision,
      ]);
      expect((await job(jobId)).errorCode).toBe('AI_DISABLED_FOR_STUDY');
      expect(answer(await send(owner, 'post', summaryPath(studyId)))).toStrictEqual([
        422,
        envelope({
          code: 'AI_DISABLED_FOR_STUDY',
          message: 'AI features are turned off for this study',
        }),
      ]);
      expect(
        answer(
          await send(owner, 'put', settingsPath(studyId), { expectedRevision: 1, aiEnabled: true }),
        ),
      ).toStrictEqual([
        409,
        envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision: 2 }),
      ]);
    });

    it("gives another user the same 404 on a study's AI settings, requests and jobs, writing nothing", async () => {
      const alice = await optedIn();
      const bob = await optedIn();
      const studyId = await createStudy(alice);
      const { jobId } = await requested(alice, studyId);
      expect(answer(await send(bob, 'get', settingsPath(studyId)))).toStrictEqual([404, NOT_FOUND]);
      expect(
        answer(
          await send(bob, 'put', settingsPath(studyId), { expectedRevision: 1, aiEnabled: false }),
        ),
      ).toStrictEqual([404, NOT_FOUND]);
      expect(answer(await send(bob, 'post', summaryPath(studyId)))).toStrictEqual([404, NOT_FOUND]);
      expect(answer(await send(bob, 'get', jobPath(studyId, jobId)))).toStrictEqual([
        404,
        NOT_FOUND,
      ]);
      expect(answer(await send(alice, 'get', jobPath(studyId, randomUUID())))).toStrictEqual([
        404,
        NOT_FOUND,
      ]);
      expect(await AiJob.count({ where: { studyId } })).toBe(1);
      expect((await job(jobId)).state).toBe('queued');
    });

    it('GET /v1/me/ai-consent and PUT /v1/me/ai-consent touch only the signed-in user', async () => {
      const alice = await optedIn();
      const bob = await signedInUser();
      const bobOff = await send(bob, 'put', CONSENT, { expectedRevision: 1, enabled: false });
      expect(answer(bobOff)).toStrictEqual([
        200,
        { enabled: false, consentVersion: null, revision: 2, cancelledJobCount: 0 },
      ]);
      const aliceStored = await User.findByPk(alice.user.id, { rejectOnEmpty: true });
      expect([aliceStored.aiEnabled, aliceStored.aiSettingsRevision]).toStrictEqual([true, 2]);
      expect((await send(alice, 'get', CONSENT)).body).toMatchObject({ enabled: true });
      expect(answer(await send(bob, 'get', CONSENT))).toStrictEqual([
        200,
        {
          enabled: false,
          consentVersion: null,
          consentedAt: null,
          currentConsentVersion: AI_CONSENT_VERSION,
          needsRenewal: false,
          revision: 2,
          providerAvailable: true,
          provider: 'Fake (development)',
          modelId: 'fake-model-1',
          remaining: { thisHour: 20, today: 50 },
        },
      ]);
    });
  });

  describe('jobs (BIB-39)', () => {
    it('queues without waiting for the provider, then the worker publishes a validated result citing only manifest ids', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const accepted = await send(owner, 'post', summaryPath(studyId));
      expect(answer(accepted)).toStrictEqual([
        202,
        {
          jobId: anyId,
          basisRevision: study.contentRevision,
          statusUrl: expect.stringMatching(new RegExp(`^/v1/studies/${studyId}/ai/jobs/`)),
          outcome: 'queued',
        },
      ]);
      const { jobId } = accepted.body as AiJobAcceptedResponse;
      expect(fake.calls).toBe(0);
      expect((await send(owner, 'get', jobPath(studyId, jobId))).body).toMatchObject({
        state: 'queued',
        result: null,
        context: null,
      });

      expect(await runner.runOnce()).toBe(jobId);
      const manifest = await ContextManifest.findOne({ where: { jobId }, rejectOnEmpty: true });
      const ids = manifest.entries.map((entry) => entry.id);
      expect(manifest.entries.map((entry) => [entry.kind, entry.priority])).toContainEqual([
        'study',
        'required',
      ]);
      const status = await send(owner, 'get', jobPath(studyId, jobId));
      expect(answer(status)).toStrictEqual([
        200,
        {
          jobId,
          studyId,
          capability: 'summary',
          state: 'succeeded',
          basisRevision: study.contentRevision,
          currentRevision: study.contentRevision,
          stale: false,
          attemptCount: 1,
          errorCode: null,
          retryable: false,
          createdAt: anyTime,
          finishedAt: anyTime,
          context: {
            tokenBudget: 12_000,
            tokenCount: expect.any(Number),
            includedCount: ids.length,
            omittedCount: 0,
            coverageWarnings: [],
          },
          result: {
            id: anyId,
            modelId: 'fake-model-1',
            promptVersion: 'summary-prompt-v1',
            // BIB-43: the StudySummary revision it stored, current because nothing changed since.
            output: { summaryId: anyId, current: true, droppedCount: 0 },
            createdAt: anyTime,
          },
        },
      ]);
    });

    it('coalesces an equivalent waiting request and replays an Idempotency-Key, refusing it for another study', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const otherStudyId = await createStudy(owner);
      const key = randomUUID();
      const first = await send(owner, 'post', summaryPath(studyId), undefined, key);
      const firstJob = (first.body as AiJobAcceptedResponse).jobId;
      const again = await send(owner, 'post', summaryPath(studyId));
      expect((again.body as AiJobAcceptedResponse).jobId).toBe(firstJob);
      expect((again.body as AiJobAcceptedResponse).outcome).toBe('existing');
      expect(
        answer(await send(owner, 'post', summaryPath(otherStudyId), undefined, key)),
      ).toStrictEqual([
        422,
        envelope({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used for a different request',
        }),
      ]);
      expect(await AiJob.count({ where: { ownerId: owner.user.id } })).toBe(1);
    });

    it('a provider outage fails the job with an explicit retryable status after two retries, and study editing still works (FR-AI-012)', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      fake.script('transient', 'transient', 'transient');
      expect(await runner.runOnce()).toBe(jobId);
      expect(fake.calls).toBe(3);
      expect((await send(owner, 'get', jobPath(studyId, jobId))).body).toMatchObject({
        state: 'failed',
        errorCode: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        result: null,
      });
      const revision = (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
      const edit = await send(owner, 'post', `/v1/studies/${studyId}/nodes`, {
        expectedRevision: revision,
        type: 'thought',
        text: 'Still editable',
      });
      expect(edit.status).toBe(201);
      // A transient error followed by success recovers within the same job.
      const retried = await requested(owner, studyId);
      fake.script('transient');
      await runner.runOnce();
      expect((await job(retried.jobId)).state).toBe('succeeded');
    });

    it('a provider that never answers times out inside the request budget', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      fake.script('hang', 'hang', 'hang');
      await runner.runOnce();
      expect([(await job(jobId)).state, (await job(jobId)).errorCode]).toStrictEqual([
        'failed',
        'PROVIDER_TIMEOUT',
      ]);
    });

    it('output citing an id outside the manifest is rejected and nothing is published (FR-AI-006)', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      fake.script('invented-id');
      await runner.runOnce();
      expect([(await job(jobId)).state, (await job(jobId)).errorCode]).toStrictEqual([
        'failed',
        'VALIDATION_FAILED',
      ]);
      expect(await AiResult.count({ where: { jobId } })).toBe(0);
    });

    it('reclaims a job whose lease expired, and fails it after three claims', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const crashed = await requested(owner, studyId);
      const expired = {
        state: 'running' as const,
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() - 1000),
      };
      await AiJob.update({ ...expired, attemptCount: 1 }, { where: { id: crashed.jobId } });
      expect(await runner.runOnce()).toBe(crashed.jobId);
      expect([
        (await job(crashed.jobId)).state,
        (await job(crashed.jobId)).attemptCount,
      ]).toStrictEqual(['succeeded', 2]);

      // BIB-43: a manual regenerate is allowed once per ten seconds.
      await AiJob.update(
        { createdAt: new Date(Date.now() - 11_000) },
        { where: { id: crashed.jobId } },
      );
      const exhausted = await requested(owner, studyId);
      await AiJob.update({ ...expired, attemptCount: 3 }, { where: { id: exhausted.jobId } });
      expect(await runner.runOnce()).toBeNull();
      expect([
        (await job(exhausted.jobId)).state,
        (await job(exhausted.jobId)).errorCode,
      ]).toStrictEqual(['failed', 'LEASE_EXPIRED']);
    });

    it('runs one job per study at a time: a second job waits while the study has a live lease', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const running = await requested(owner, studyId);
      await AiJob.update(
        { state: 'running', leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) },
        { where: { id: running.jobId } },
      );
      const waiting = await AiJob.create({
        ownerId: owner.user.id,
        studyId,
        capability: 'summary',
        requestKey: `test:${randomUUID()}`,
        basisRevision: 1,
        consentVersion: AI_CONSENT_VERSION,
      });
      expect(await runner.runOnce()).toBeNull();
      expect((await job(waiting.id)).state).toBe('queued');
    });

    it('the hourly request limit answers 429 with Retry-After', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      await AiJob.bulkCreate(
        Array.from({ length: 20 }, () => ({
          ownerId: owner.user.id,
          studyId,
          capability: 'summary',
          requestKey: `test:${randomUUID()}`,
          basisRevision: 1,
          consentVersion: AI_CONSENT_VERSION,
          state: 'failed',
          errorCode: 'PROVIDER_ERROR',
          finishedAt: new Date(),
        })),
      );
      const res = await send(owner, 'post', summaryPath(studyId));
      expect(answer(res)).toStrictEqual([
        429,
        envelope({
          code: 'AI_QUOTA_EXCEEDED',
          message: 'You have reached the AI request limit. Try again later',
          retryable: true,
        }),
      ]);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    async function trash(owner: Owner, studyId: string): Promise<void> {
      const { revision } = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const res = await send(owner, 'delete', `/v1/studies/${studyId}`, {
        expectedRevision: revision,
      });
      expect(res.status).toBe(200);
    }

    it('a study trashed after the request is never sent: the job is cancelled with no provider call', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      await trash(owner, studyId);
      expect(await runner.runOnce()).toBe(jobId);
      expect(fake.calls).toBe(0);
      const stored = await job(jobId);
      expect([stored.state, stored.errorCode]).toStrictEqual(['cancelled', 'STUDY_UNAVAILABLE']);
      expect(await ContextManifest.count({ where: { jobId } })).toBe(0);
      expect(await AiResult.count({ where: { jobId } })).toBe(0);
    });

    it('a study trashed while the provider is answering discards the output', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      fake.beforeAnswer = () => trash(owner, studyId);
      expect(await runner.runOnce()).toBe(jobId);
      expect(fake.calls).toBe(1);
      const stored = await job(jobId);
      expect([stored.state, stored.errorCode]).toStrictEqual(['cancelled', 'STUDY_UNAVAILABLE']);
      expect(await AiResult.count({ where: { jobId } })).toBe(0);
    });

    it('marks a finished job stale once the study content moves past its basis', async () => {
      const owner = await optedIn();
      const studyId = await createStudy(owner);
      const { jobId } = await requested(owner, studyId);
      await runner.runOnce();
      const revision = (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
      await send(owner, 'post', `/v1/studies/${studyId}/nodes`, {
        expectedRevision: revision,
        type: 'thought',
        text: 'A new thought',
      });
      expect((await send(owner, 'get', jobPath(studyId, jobId))).body).toMatchObject({
        state: 'succeeded',
        stale: true,
      });
    });
  });
});
