import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  AI_CONSENT_VERSION,
  type AiJobAcceptedResponse,
  type AiProposalListResponse,
  type AiSuggestionListResponse,
  type CreateNodeResponse,
  type CreateStudyResponse,
  type ReasoningPathResponse,
  type StudySummaryResponse,
} from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AiJob } from '../src/database/models/ai-job.model';
import { AiResult } from '../src/database/models/ai-result.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { StudySummary } from '../src/database/models/study-summary.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { AiJobRunnerService } from '../src/modules/ai/ai-job-runner.service';
import { AiSummaryService } from '../src/modules/ai/ai-summary.service';
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
const anySequence: unknown = expect.stringMatching(/^[1-9][0-9]*$/);

const RUNTIME: AiRuntime = {
  leaseMs: 120_000,
  heartbeatMs: 25,
  requestBudgetMs: 2_000,
  retryBaseMs: 1,
  pollMs: 1_000,
  monthlySpendCapMicros: 1_000_000_000,
  summaryDebounceMs: 30_000,
  summaryMaxWaitMs: 120_000,
};

// Literal `/v1/studies/…` templates: the route inventory finds a cross-user test's path through them.
const summaryPath = (studyId: string): string => `/v1/studies/${studyId}/summary`;
const requestSummaryPath = (studyId: string): string => `/v1/studies/${studyId}/ai/summary`;
const tensionsPath = (studyId: string): string => `/v1/studies/${studyId}/ai/tensions`;
const questionsPath = (studyId: string): string => `/v1/studies/${studyId}/ai/questions`;
const passagesPath = (studyId: string): string => `/v1/studies/${studyId}/ai/passages`;
const proposalsPath = (studyId: string, capability: string): string =>
  `/v1/studies/${studyId}/ai/proposals?capability=${capability}`;
const acceptProposalPath = (studyId: string, proposalId: string): string =>
  `/v1/studies/${studyId}/ai/proposals/${proposalId}/accept`;
const rejectProposalPath = (studyId: string, proposalId: string): string =>
  `/v1/studies/${studyId}/ai/proposals/${proposalId}/reject`;
const reasoningPath = (studyId: string, nodeId: string): string =>
  `/v1/studies/${studyId}/nodes/${nodeId}/reasoning`;

/**
 * BIB-43 (living summary), BIB-44 (tensions, open questions), BIB-45 (passages, reasoning path).
 * Real PostgreSQL, the deterministic fake provider, the worker's runner called directly.
 */
describe('AI study insights (BIB-43, BIB-44, BIB-45)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let fake: FakeAiProvider;
  let runner: AiJobRunnerService;
  let summaries: AiSummaryService;
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
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Response> {
    let req = request(app.getHttpServer())[method](path).set('Cookie', owner.cookie);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    if (body !== undefined) req = req.send(body as object);
    return req.then((res) => res);
  }

  const answer = (res: Response): unknown[] => [res.status, res.body];

  async function optedIn(): Promise<Owner> {
    const owner = await signedInUser();
    const res = await send(owner, 'put', '/v1/me/ai-consent', {
      expectedRevision: 1,
      enabled: true,
      consentVersion: AI_CONSENT_VERSION,
    });
    expect(res.status).toBe(200);
    return owner;
  }

  async function createNode(owner: Owner, studyId: string, body: object): Promise<string> {
    const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
    const res = await send(owner, 'post', `/v1/studies/${studyId}/nodes`, {
      expectedRevision: study.revision,
      ...body,
    });
    expect(res.status).toBe(201);
    return (res.body as CreateNodeResponse).id;
  }

  async function newStudy(owner: Owner): Promise<{ studyId: string; question: string }> {
    const res = await send(owner, 'post', '/v1/studies', { question: 'What is conscience?' });
    expect(res.status).toBe(201);
    const body = res.body as CreateStudyResponse;
    return { studyId: body.studyId, question: body.questionNodeId ?? '' };
  }

  async function drain(): Promise<void> {
    while ((await runner.runOnce()) !== null) {
      // run every ready job
    }
  }

  async function requested(owner: Owner, path: string, body?: object): Promise<string> {
    const res = await send(owner, 'post', path, body);
    expect(res.status).toBe(202);
    return (res.body as AiJobAcceptedResponse).jobId;
  }

  async function getSummary(owner: Owner, studyId: string): Promise<StudySummaryResponse> {
    const res = await send(owner, 'get', summaryPath(studyId));
    expect(res.status).toBe(200);
    return res.body as StudySummaryResponse;
  }

  /** Lets a manual regenerate through (PRD section 17: once per ten seconds). */
  async function ageJobs(studyId: string): Promise<void> {
    await AiJob.update(
      { createdAt: new Date(Date.now() - 11_000) },
      { where: { studyId, capability: 'summary' } },
    );
  }

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
    db = app.get<Database>(DATABASE);
    runner = app.get(AiJobRunnerService);
    summaries = app.get(AiSummaryService);
  });

  beforeEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('living summary (BIB-43)', () => {
    it('generates a StudySummary v1 whose established finding cites a live user-established observation, with deterministic questions and conclusions', async () => {
      const alice = await optedIn();
      const { studyId, question } = await newStudy(alice);
      const observation = await createNode(alice, studyId, {
        type: 'observation',
        text: 'Conscience bears witness',
        observationKind: 'textual_observation',
      });
      const established = await send(
        alice,
        'patch',
        `/v1/studies/${studyId}/nodes/${observation}`,
        {
          expectedRevision: 1,
          establishment: 'set',
        },
      );
      expect(established.status).toBe(200);
      const conclusion = await createNode(alice, studyId, {
        type: 'conclusion',
        text: 'Conscience may be fallible',
      });

      expect(await getSummary(alice, studyId)).toStrictEqual({
        summary: null,
        stale: false,
        currentContentRevision: expect.any(Number),
        generating: false,
        lastFailure: null,
      });
      const jobId = await requested(alice, requestSummaryPath(studyId));
      expect((await getSummary(alice, studyId)).generating).toBe(true);
      await drain();

      const study = await Study.findByPk(studyId, { rejectOnEmpty: true });
      const stored = await StudySummary.findOne({ where: { jobId }, rejectOnEmpty: true });
      const item = (text: string, attribution: string, refs: unknown[], nodes: unknown[]) => ({
        id: anyId,
        text,
        attribution,
        evidenceRefs: refs,
        supportingNodeVersions: nodes,
      });
      expect(await getSummary(alice, studyId)).toStrictEqual({
        summary: {
          contractVersion: 1,
          id: stored.id,
          studyId,
          basisContentRevision: study.contentRevision,
          generatedAt: anyTime,
          promptVersion: 'summary-prompt-v1',
          modelId: 'fake-model-1',
          contextManifestId: anyId,
          focus: 'A study of 3 items',
          originalQuestionId: question,
          currentQuestionId: question,
          keyPassages: [],
          textualObservations: [],
          establishedFindings: [
            item(
              'A finding you marked as established.',
              // The fake labels this `user_statement`, but the text is not the user's stored
              // words, so the server shows it as AI synthesis (section 17).
              'ai_synthesis',
              [{ type: 'node_version', nodeId: observation, revision: 2, quote: null }],
              [{ nodeId: observation, revision: 2 }],
            ),
          ],
          tentativeFindings: [
            item(
              'These items may be connected.',
              'ai_synthesis',
              // Context order: questions, then conclusions, then other nodes.
              [
                { type: 'node_version', nodeId: question, revision: 1, quote: null },
                { type: 'node_version', nodeId: conclusion, revision: 1, quote: null },
              ],
              [
                { nodeId: question, revision: 1 },
                { nodeId: conclusion, revision: 1 },
              ],
            ),
          ],
          tensions: [],
          openQuestions: [{ nodeId: question, text: 'What is conscience?', status: 'open' }],
          conclusions: [
            {
              nodeId: conclusion,
              text: 'Conscience may be fallible',
              status: 'tentative',
              established: false,
            },
          ],
          abandonedHypotheses: [],
          nextDirections: [
            item('Consider reading the surrounding chapter.', 'ai_synthesis', [], []),
          ],
          proposedQuestions: [],
          coverageWarnings: [],
        },
        stale: false,
        currentContentRevision: study.contentRevision,
        generating: false,
        lastFailure: null,
      });
      // The summary never touched the study (AI is not a study mutation).
      expect((await Study.findByPk(studyId, { rejectOnEmpty: true })).revision).toBe(
        study.revision,
      );
      // Immutable revisions.
      await expect(
        StudySummary.update({ basisContentRevision: 99 }, { where: { id: stored.id } }),
      ).rejects.toThrow(/immutable/);
    });

    it('drops an established finding that does not rest on an eligible user-established record', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      const thought = await createNode(alice, studyId, { type: 'thought', text: 'Maybe' });
      fake.script({
        text: JSON.stringify({
          focus: 'Conscience',
          keyPassages: [],
          textualObservations: [],
          establishedFindings: [
            {
              text: 'Conscience is reliable.',
              attribution: 'ai_synthesis',
              evidence: [{ id: thought }],
            },
          ],
          tentativeFindings: [],
          tensions: [],
          abandonedHypotheses: [],
          nextDirections: [],
          proposedQuestions: [],
        }),
      });
      const jobId = await requested(alice, requestSummaryPath(studyId));
      await drain();
      const result = await AiResult.findOne({ where: { jobId }, rejectOnEmpty: true });
      expect(result.outputJson).toStrictEqual({
        summaryId: expect.any(String),
        current: true,
        droppedCount: 1,
      });
      expect((await getSummary(alice, studyId)).summary?.establishedFindings).toStrictEqual([]);
    });

    it('keeps an old-basis result as history, marks the current summary stale, and keeps it through a failure', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      const first = await requested(alice, requestSummaryPath(studyId));
      await drain();
      const current = await StudySummary.findOne({ where: { jobId: first }, rejectOnEmpty: true });

      // A committed content change makes it stale at once.
      await createNode(alice, studyId, { type: 'thought', text: 'A new thought' });
      const stale = await getSummary(alice, studyId);
      expect([stale.summary?.id, stale.stale]).toStrictEqual([current.id, true]);

      // A job whose basis moves on while it runs is stored as historical, never current.
      await ageJobs(studyId);
      const second = await requested(alice, requestSummaryPath(studyId));
      fake.beforeAnswer = async () => {
        fake.beforeAnswer = null;
        await createNode(alice, studyId, { type: 'thought', text: 'Written during generation' });
      };
      await drain();
      const historical = await StudySummary.findOne({
        where: { jobId: second },
        rejectOnEmpty: true,
      });
      expect(historical.publishedCurrent).toBe(false);
      expect(
        (await AiResult.findOne({ where: { jobId: second }, rejectOnEmpty: true })).outputJson,
      ).toStrictEqual({ summaryId: historical.id, current: false, droppedCount: 0 });
      const afterHistorical = await getSummary(alice, studyId);
      expect([afterHistorical.summary?.id, afterHistorical.stale]).toStrictEqual([
        current.id,
        true,
      ]);

      // A failed generation leaves the last valid summary and says so.
      await ageJobs(studyId);
      await requested(alice, requestSummaryPath(studyId));
      fake.script('refused');
      await drain();
      const failed = await getSummary(alice, studyId);
      expect([failed.summary?.id, failed.stale, failed.lastFailure]).toStrictEqual([
        current.id,
        true,
        { errorCode: 'PROVIDER_REFUSED', retryable: false },
      ]);
    });

    it('allows a manual regenerate once per ten seconds', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      await requested(alice, requestSummaryPath(studyId));
      await drain();
      const again = await send(alice, 'post', requestSummaryPath(studyId));
      expect(answer(again)).toStrictEqual([
        429,
        envelope({
          code: 'AI_QUOTA_EXCEEDED',
          message: 'You have reached the AI request limit. Try again later',
          retryable: true,
        }),
      ]);
    });

    it('debounces automatic summaries after significant changes (30 s, at most 2 min) and queues one follow-up after a running job', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      await requested(alice, requestSummaryPath(studyId));
      await drain();
      const t0 = Date.now();
      const at = (ms: number) => new Date(t0 + ms);
      const scope = { ownerId: alice.user.id, studyId };
      const schedule = (now: Date) => summaries.scheduleAutomatic(now, scope);
      const automatic = () =>
        AiJob.count({ where: { studyId, capability: 'summary', trigger: 'automatic' } });

      await schedule(at(0));
      expect(await automatic()).toBe(0);

      await createNode(alice, studyId, { type: 'thought', text: 'First change' });
      await schedule(at(1_000)); // seen: dirty from now
      await schedule(at(20_000)); // under 30 s since the last change
      expect(await automatic()).toBe(0);
      await createNode(alice, studyId, { type: 'thought', text: 'Second change' });
      await schedule(at(40_000)); // a new change resets the 30 s
      await schedule(at(60_000));
      expect(await automatic()).toBe(0);
      await schedule(at(70_001)); // 30 s quiet
      expect(await automatic()).toBe(1);

      // One summary job per study: while it waits, a change only stays dirty.
      await createNode(alice, studyId, { type: 'thought', text: 'While queued' });
      await schedule(at(80_000));
      await schedule(at(200_000)); // past two minutes, but a job is pending
      expect(await automatic()).toBe(1);
      // A change committed while it runs is not in its basis: one follow-up afterwards.
      fake.beforeAnswer = async () => {
        fake.beforeAnswer = null;
        await createNode(alice, studyId, { type: 'thought', text: 'While running' });
      };
      await drain();
      await schedule(at(201_000));
      expect(await automatic()).toBe(1);
      await schedule(at(231_001));
      expect(await automatic()).toBe(2);
      await drain();
      const latest = await getSummary(alice, studyId);
      expect(latest.stale).toBe(false);
    });

    it('queues a follow-up for a change committed while the first summary of a study was running', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      fake.beforeAnswer = async () => {
        fake.beforeAnswer = null;
        await createNode(alice, studyId, { type: 'thought', text: 'While the first one ran' });
      };
      await requested(alice, requestSummaryPath(studyId));
      await drain();
      expect((await getSummary(alice, studyId)).stale).toBe(true);
      const t0 = Date.now();
      const scope = { ownerId: alice.user.id, studyId };
      const automatic = () =>
        AiJob.count({ where: { studyId, capability: 'summary', trigger: 'automatic' } });
      await summaries.scheduleAutomatic(new Date(t0), scope);
      expect(await automatic()).toBe(0);
      await summaries.scheduleAutomatic(new Date(t0 + 30_001), scope);
      expect(await automatic()).toBe(1);
      await drain();
      expect((await getSummary(alice, studyId)).stale).toBe(false);
    });

    it('queues an automatic summary at most two minutes after the first change during sustained editing', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      await requested(alice, requestSummaryPath(studyId));
      await drain();
      const t0 = Date.now();
      const scope = { ownerId: alice.user.id, studyId };
      const automatic = () =>
        AiJob.count({ where: { studyId, capability: 'summary', trigger: 'automatic' } });
      for (let second = 0; second < 120; second += 20) {
        await createNode(alice, studyId, { type: 'thought', text: `Edit ${second}` });
        await summaries.scheduleAutomatic(new Date(t0 + second * 1000), scope);
      }
      expect(await automatic()).toBe(0);
      await createNode(alice, studyId, { type: 'thought', text: 'Still editing' });
      await summaries.scheduleAutomatic(new Date(t0 + 120_000), scope);
      expect(await automatic()).toBe(1);
    });
  });

  describe('tensions and open questions (BIB-44)', () => {
    it('proposes a tension between two claims; accepting adds the relationship and leaves the conclusion status unchanged', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      const conclusion = await createNode(alice, studyId, {
        type: 'conclusion',
        text: 'Conscience is always reliable',
      });
      const thought = await createNode(alice, studyId, {
        type: 'thought',
        text: 'Consciences can be seared',
      });
      const jobId = await requested(alice, tensionsPath(studyId));
      await drain();
      const listed = await send(
        alice,
        'get',
        `/v1/studies/${studyId}/ai/suggestions?capability=tensions`,
      );
      const items = (listed.body as AiSuggestionListResponse).items;
      expect(answer(listed)).toStrictEqual([
        200,
        {
          items: [
            {
              id: anyId,
              studyId,
              capability: 'tensions',
              status: 'proposed',
              sourceNodeId: conclusion,
              targetNodeId: thought,
              type: 'qualifies',
              rationale: 'These two statements may pull in different directions.',
              caveat: 'This is one possible reading; the two may be compatible.',
              evidence: [
                { id: conclusion, quote: null },
                { id: thought, quote: null },
              ],
              revision: 1,
              basisRevision: expect.any(Number),
              modelId: 'fake-model-1',
              createdAt: anyTime,
              decidedAt: null,
              acceptedEdgeId: null,
            },
          ],
        },
      ]);
      expect(
        (await AiResult.findOne({ where: { jobId }, rejectOnEmpty: true })).outputJson,
      ).toStrictEqual({ suggestionIds: [items[0]?.id], suppressedCount: 0, droppedCount: 0 });
      // Generation changed no status.
      expect((await StudyNode.findByPk(conclusion, { rejectOnEmpty: true })).conclusionStatus).toBe(
        'tentative',
      );

      const accepted = await send(
        alice,
        'post',
        `/v1/studies/${studyId}/ai/suggestions/${items[0]?.id}/accept`,
        { expectedRevision: 1 },
      );
      expect(accepted.status).toBe(200);
      const edge = await StudyEdge.findOne({
        where: { studyId, suggestionId: items[0]?.id ?? '' },
        rejectOnEmpty: true,
      });
      expect([edge.sourceNodeId, edge.targetNodeId, edge.type, edge.origin]).toStrictEqual([
        conclusion,
        thought,
        'qualifies',
        'ai',
      ]);
      const after = await StudyNode.findByPk(conclusion, { rejectOnEmpty: true });
      expect([after.conclusionStatus, after.establishedAt]).toStrictEqual(['tentative', null]);
    });

    it('reports existing open questions without changing their status and proposes new ones separately; accept (edited), replay, 428 and 409', async () => {
      const alice = await optedIn();
      const { studyId, question } = await newStudy(alice);
      const jobId = await requested(alice, questionsPath(studyId));
      await drain();
      const output = (await AiResult.findOne({ where: { jobId }, rejectOnEmpty: true }))
        .outputJson as { existingOpenQuestionIds: string[]; suggestionIds: string[] };
      expect(output).toStrictEqual({
        existingOpenQuestionIds: [question],
        suggestionIds: [expect.any(String)],
        suppressedCount: 0,
        droppedCount: 0,
      });
      expect((await StudyNode.findByPk(question, { rejectOnEmpty: true })).questionStatus).toBe(
        'open',
      );
      const listed = await send(alice, 'get', proposalsPath(studyId, 'questions'));
      const proposalId = output.suggestionIds[0] ?? '';
      expect(answer(listed)).toStrictEqual([
        200,
        {
          items: [
            {
              id: proposalId,
              studyId,
              capability: 'questions',
              status: 'proposed',
              text: 'What does the surrounding passage add to this question?',
              rationale: 'The study has not recorded the surrounding context yet.',
              evidence: [{ id: question, quote: null }],
              revision: 1,
              basisRevision: expect.any(Number),
              modelId: 'fake-model-1',
              createdAt: anyTime,
              decidedAt: null,
              acceptedNodeId: null,
            },
          ],
        },
      ]);

      expect(
        answer(await send(alice, 'post', acceptProposalPath(studyId, proposalId), {})),
      ).toStrictEqual([
        428,
        envelope({ code: 'REVISION_MISSING', message: 'expectedRevision is required' }),
      ]);
      expect(
        answer(
          await send(alice, 'post', acceptProposalPath(studyId, proposalId), {
            expectedRevision: 5,
          }),
        ),
      ).toStrictEqual([
        409,
        envelope({ code: 'REVISION_CONFLICT', message: 'Revision conflict', currentRevision: 1 }),
      ]);
      const key = randomUUID();
      const body = { expectedRevision: 1, text: 'What does Romans 9:1 add?' };
      const accepted = await send(
        alice,
        'post',
        acceptProposalPath(studyId, proposalId),
        body,
        key,
      );
      const expected = {
        proposalId,
        status: 'accepted',
        revision: 2,
        outcome: 'created',
        node: { id: anyId, type: 'question' },
        lastEventSequence: anySequence,
      };
      expect(answer(accepted)).toStrictEqual([200, expected]);
      const replay = await send(alice, 'post', acceptProposalPath(studyId, proposalId), body, key);
      expect(answer(replay)).toStrictEqual([200, accepted.body]);
      const nodeId = (accepted.body as { node: { id: string } }).node.id;
      const node = await StudyNode.findByPk(nodeId, { rejectOnEmpty: true });
      expect([node.type, node.origin, node.title, node.questionStatus]).toStrictEqual([
        'question',
        'ai',
        'What does Romans 9:1 add?',
        'open',
      ]);
      // A second accept without the key replays the node without writing.
      expect(
        answer(
          await send(alice, 'post', acceptProposalPath(studyId, proposalId), {
            expectedRevision: 2,
          }),
        ),
      ).toStrictEqual([
        200,
        {
          ...expected,
          outcome: 'existing',
          node: { id: nodeId, type: 'question' },
          lastEventSequence: null,
        },
      ]);
      // Proposals and suggestions are separate routes.
      expect(
        answer(
          await send(alice, 'post', `/v1/studies/${studyId}/ai/suggestions/${proposalId}/reject`, {
            expectedRevision: 2,
          }),
        ),
      ).toStrictEqual([404, NOT_FOUND]);
    });

    it('a dismissed question proposal is suppressed until the user regenerates', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      await requested(alice, questionsPath(studyId));
      await drain();
      const [proposal] = (
        (await send(alice, 'get', proposalsPath(studyId, 'questions')))
          .body as AiProposalListResponse
      ).items;
      expect(
        answer(
          await send(alice, 'post', rejectProposalPath(studyId, proposal?.id ?? ''), {
            expectedRevision: 1,
          }),
        ),
      ).toStrictEqual([
        200,
        {
          proposalId: proposal?.id,
          status: 'rejected',
          revision: 2,
          lastEventSequence: anySequence,
        },
      ]);
      await requested(alice, questionsPath(studyId));
      await drain();
      expect(
        (
          (await send(alice, 'get', proposalsPath(studyId, 'questions')))
            .body as AiProposalListResponse
        ).items,
      ).toStrictEqual([]);
      await requested(alice, questionsPath(studyId), { regenerate: true });
      await drain();
      expect(
        (
          (await send(alice, 'get', proposalsPath(studyId, 'questions')))
            .body as AiProposalListResponse
        ).items,
      ).toHaveLength(1);
    });
  });

  describe('passages and reasoning (BIB-45)', () => {
    it('shows only passages that resolve in the local corpus, and accepting one adds its Scripture node', async () => {
      const alice = await optedIn();
      const { studyId } = await newStudy(alice);
      const jobId = await requested(alice, passagesPath(studyId));
      await drain();
      expect(
        (await AiResult.findOne({ where: { jobId }, rejectOnEmpty: true })).outputJson,
      ).toStrictEqual({ suggestionIds: [expect.any(String)], suppressedCount: 0, droppedCount: 1 });
      const listed = await send(alice, 'get', proposalsPath(studyId, 'passages'));
      expect(answer(listed)).toStrictEqual([
        200,
        {
          items: [
            {
              id: anyId,
              studyId,
              capability: 'passages',
              status: 'proposed',
              reference: { referenceId: anyId, editionId: anyId, label: 'Romans 8:16' },
              reason: 'This passage may speak about inner witness.',
              revision: 1,
              basisRevision: expect.any(Number),
              modelId: 'fake-model-1',
              createdAt: anyTime,
              decidedAt: null,
              acceptedNodeId: null,
            },
          ],
        },
      ]);
      const proposal = (listed.body as AiProposalListResponse).items[0];
      const accepted = await send(alice, 'post', acceptProposalPath(studyId, proposal?.id ?? ''), {
        expectedRevision: 1,
      });
      expect(accepted.status).toBe(200);
      const nodeId = (accepted.body as { node: { id: string } }).node.id;
      const node = await StudyNode.findByPk(nodeId, { rejectOnEmpty: true });
      expect([node.type, node.origin]).toStrictEqual(['scripture', 'scripture']);
      if (proposal?.capability !== 'passages') throw new Error('expected a passage');
      expect(node.scriptureReferenceId).toBe(proposal.reference.referenceId);

      // Already in the study now: a new request does not propose it again.
      await requested(alice, passagesPath(studyId));
      await drain();
      expect(
        (
          (await send(alice, 'get', proposalsPath(studyId, 'passages')))
            .body as AiProposalListResponse
        ).items,
      ).toStrictEqual([]);
    });

    it("shows a conclusion's recorded path with its gaps stated, without AI", async () => {
      const alice = await signedInUser(); // no AI consent at all
      const { studyId } = await newStudy(alice);
      const conclusion = await createNode(alice, studyId, {
        type: 'conclusion',
        text: 'Conscience may be fallible',
      });
      const res = await send(alice, 'get', reasoningPath(studyId, conclusion));
      const path = res.body as ReasoningPathResponse;
      expect(answer(res)).toStrictEqual([
        200,
        {
          nodeId: conclusion,
          steps: [
            {
              kind: 'version',
              versionId: anyId,
              versionNumber: 1,
              action: 'created',
              statement: 'Conscience may be fallible',
              status: 'tentative',
              established: false,
              createdAt: anyTime,
              eventId: anyId,
              eventSequence: anySequence,
              evidence: [],
            },
          ],
          gaps: [
            {
              code: 'no_evidence_recorded',
              message: 'No supporting evidence was recorded with this version.',
              versionId: path.steps[0]?.kind === 'version' ? path.steps[0].versionId : null,
              edgeId: null,
            },
          ],
        },
      ]);
    });
  });

  it("gives another user the same 404 on a study's summary, insight requests, proposals and reasoning, writing nothing", async () => {
    const alice = await optedIn();
    const bob = await optedIn();
    const { studyId, question } = await newStudy(alice);
    await requested(alice, questionsPath(studyId));
    await drain();
    const [proposal] = (
      (await send(alice, 'get', proposalsPath(studyId, 'questions'))).body as AiProposalListResponse
    ).items;
    const proposalId = proposal?.id ?? '';
    const jobsBefore = await AiJob.count({ where: { ownerId: bob.user.id } });

    for (const [method, path, body] of [
      ['get', summaryPath(studyId), undefined],
      ['post', tensionsPath(studyId), {}],
      ['post', questionsPath(studyId), {}],
      ['post', passagesPath(studyId), {}],
      ['get', proposalsPath(studyId, 'questions'), undefined],
      ['post', acceptProposalPath(studyId, proposalId), { expectedRevision: 1 }],
      ['post', rejectProposalPath(studyId, proposalId), { expectedRevision: 1 }],
      ['get', reasoningPath(studyId, question), undefined],
    ] as const) {
      expect(answer(await send(bob, method, path, body))).toStrictEqual([404, NOT_FOUND]);
    }
    // Bob's own study with Alice's proposal: 404 too.
    const bobs = await newStudy(bob);
    expect(
      answer(
        await send(bob, 'post', acceptProposalPath(bobs.studyId, proposalId), {
          expectedRevision: 1,
        }),
      ),
    ).toStrictEqual([404, NOT_FOUND]);
    expect(await AiJob.count({ where: { ownerId: bob.user.id } })).toBe(jobsBefore);
    const listed = (
      (await send(alice, 'get', proposalsPath(studyId, 'questions'))).body as AiProposalListResponse
    ).items;
    expect(listed.map((item) => [item.id, item.status, item.revision])).toStrictEqual([
      [proposalId, 'proposed', 1],
    ]);
  });
});
