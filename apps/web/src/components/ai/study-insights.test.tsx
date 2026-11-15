import type {
  AiProposal,
  NodeSummary,
  ReasoningPathResponse,
  StudySummary,
} from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REASONING_COPY, ReasoningPath } from '@/components/nodes/reasoning-path';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { INSIGHTS_COPY, StudyInsights } from './study-insights';
import { SUMMARY_COPY, StudySummaryPanel } from './study-summary';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const QUE = '10000000-2222-4333-8444-555555555555';
const OBS = '20000000-2222-4333-8444-555555555555';
const PRO = '30000000-2222-4333-8444-555555555555';
const JOB = '40000000-2222-4333-8444-555555555555';
const REF = '50000000-2222-4333-8444-555555555555';
const EDI = '60000000-2222-4333-8444-555555555555';
const NEW = '70000000-2222-4333-8444-555555555555';
const VER = '80000000-2222-4333-8444-555555555555';
const SUM = '90000000-2222-4333-8444-555555555555';
const T = '2026-11-15T12:00:00.000Z';

const node = (id: string, type: NodeSummary['type'], label: string): NodeSummary => ({
  id,
  type,
  origin: 'user',
  label,
  status: type === 'question' ? 'open' : null,
  observationKind: type === 'observation' ? 'textual_observation' : null,
  referenceId: null,
  canonicalNodeId: null,
  established: type === 'observation',
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
});
const NODES = [node(QUE, 'question', 'What is conscience?'), node(OBS, 'observation', 'Witness')];

const summary: StudySummary = {
  contractVersion: 1,
  id: SUM,
  studyId: STUDY_ID,
  basisContentRevision: 3,
  generatedAt: T,
  promptVersion: 'summary-prompt-v1',
  modelId: 'fake-model-1',
  contextManifestId: JOB,
  focus: 'Conscience and the Holy Spirit',
  originalQuestionId: QUE,
  currentQuestionId: QUE,
  keyPassages: [],
  textualObservations: [],
  establishedFindings: [
    {
      id: PRO,
      text: 'Conscience bears witness.',
      attribution: 'user_statement',
      evidenceRefs: [{ type: 'node_version', nodeId: OBS, revision: 1, quote: null }],
      supportingNodeVersions: [{ nodeId: OBS, revision: 1 }],
    },
  ],
  tentativeFindings: [],
  tensions: [],
  openQuestions: [{ nodeId: QUE, text: 'What is conscience?', status: 'open' }],
  conclusions: [],
  abandonedHypotheses: [],
  nextDirections: [],
  proposedQuestions: [],
  coverageWarnings: [],
};

let replies: Map<string, Response[]>;
let requests: { method: string; path: string; body: unknown }[];

function reply(route: string, ...answers: Response[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);
}

beforeEach(() => {
  replies = new Map();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      requests.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = replies.get(`${method} ${path}`)?.shift();
      if (next) return Promise.resolve(next);
      if (method === 'GET' && path === `/studies/${STUDY_ID}/nodes`) {
        return Promise.resolve(jsonResponse(200, { items: NODES }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StudySummaryPanel (BIB-43)', () => {
  it('shows the AI summary with its attribution, evidence and stale label, keeps it through a failure, and regenerates on request', async () => {
    reply(
      `GET /studies/${STUDY_ID}/summary`,
      jsonResponse(200, {
        summary,
        stale: true,
        currentContentRevision: 5,
        generating: false,
        lastFailure: { errorCode: 'PROVIDER_ERROR', retryable: true },
      }),
      jsonResponse(200, {
        summary,
        stale: true,
        currentContentRevision: 5,
        generating: false,
        lastFailure: null,
      }),
    );
    reply(
      `POST /studies/${STUDY_ID}/ai/summary`,
      jsonResponse(202, {
        jobId: JOB,
        basisRevision: 5,
        statusUrl: `/v1/studies/${STUDY_ID}/ai/jobs/${JOB}`,
        outcome: 'queued',
      }),
    );
    renderWithQuery(<StudySummaryPanel studyId={STUDY_ID} active />);
    const badge = await screen.findByText(SUMMARY_COPY.badge);
    const article = badge.closest('article');
    expect(textOf(article)).toContain(SUMMARY_COPY.stale);
    expect(textOf(article)).toContain('Focus: Conscience and the Holy Spirit');
    expect(textOf(article)).toContain('What is conscience? (open) · You');
    expect(textOf(article)).toContain('Conscience bears witness. (You)');
    await waitFor(() => expect(textOf(article)).toContain('Evidence: Observation: Witness'));
    expect(screen.getByRole('alert')).toHaveProperty('textContent', SUMMARY_COPY.failed);
    fireEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.regenerate }));
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toStrictEqual([
        `/studies/${STUDY_ID}/ai/summary`,
      ]),
    );
  });
});

describe('StudyInsights (BIB-44, BIB-45)', () => {
  it('asks for passages only when asked, then adds a verified passage to the study', async () => {
    const passage: AiProposal = {
      id: PRO,
      studyId: STUDY_ID,
      capability: 'passages',
      status: 'proposed',
      reference: { referenceId: REF, editionId: EDI, label: 'Romans 8:16' },
      reason: 'This passage may speak about inner witness.',
      revision: 1,
      basisRevision: 3,
      modelId: 'fake-model-1',
      createdAt: T,
      decidedAt: null,
      acceptedNodeId: null,
    };
    const AI = `/studies/${STUDY_ID}/ai`;
    reply(`GET ${AI}/suggestions?capability=tensions`, jsonResponse(200, { items: [] }));
    reply(`GET ${AI}/proposals?capability=questions`, jsonResponse(200, { items: [] }));
    reply(
      `GET ${AI}/proposals?capability=passages`,
      jsonResponse(200, { items: [] }),
      jsonResponse(200, { items: [passage] }),
      jsonResponse(200, { items: [] }),
    );
    reply(
      `POST ${AI}/passages`,
      jsonResponse(202, {
        jobId: JOB,
        basisRevision: 3,
        statusUrl: `/v1${AI}/jobs/${JOB}`,
        outcome: 'queued',
      }),
    );
    reply(
      `GET ${AI}/jobs/${JOB}`,
      jsonResponse(200, {
        jobId: JOB,
        studyId: STUDY_ID,
        capability: 'passages',
        state: 'succeeded',
        basisRevision: 3,
        currentRevision: 3,
        stale: false,
        attemptCount: 1,
        errorCode: null,
        retryable: false,
        createdAt: T,
        finishedAt: T,
        context: null,
        result: {
          id: SUM,
          modelId: 'fake-model-1',
          promptVersion: 'passages-prompt-v1',
          output: { suggestionIds: [PRO], suppressedCount: 0, droppedCount: 1 },
          createdAt: T,
        },
      }),
    );
    reply(
      `POST ${AI}/proposals/${PRO}/accept`,
      jsonResponse(200, {
        proposalId: PRO,
        status: 'accepted',
        revision: 2,
        outcome: 'created',
        node: { id: NEW, type: 'scripture' },
        lastEventSequence: '9',
      }),
    );
    renderWithQuery(<StudyInsights studyId={STUDY_ID} active />);
    expect(requests).toStrictEqual([]);
    fireEvent.click(screen.getByRole('button', { name: INSIGHTS_COPY.open }));
    fireEvent.click(await screen.findByRole('button', { name: INSIGHTS_COPY.findPassages }));
    const card = (await screen.findByText('This passage may speak about inner witness.')).closest(
      'li',
    ) as HTMLElement;
    expect(textOf(card)).toContain('AI suggested Romans 8:16');
    expect(textOf(card)).toContain('Why: This passage may speak about inner witness.');
    expect(within(card).getByRole('link', { name: /^Open in reader/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /^Add to study/ }));
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'POST')).toStrictEqual([
        { method: 'POST', path: `${`/studies/${STUDY_ID}/ai`}/passages`, body: {} },
        {
          method: 'POST',
          path: `/studies/${STUDY_ID}/ai/proposals/${PRO}/accept`,
          body: { expectedRevision: 1 },
        },
      ]),
    );
  });
});

describe('ReasoningPath (BIB-45)', () => {
  it('shows the recorded path and states its gaps, reading nothing until opened', async () => {
    const path: ReasoningPathResponse = {
      nodeId: OBS,
      steps: [
        {
          kind: 'version',
          versionId: VER,
          versionNumber: 1,
          action: 'created',
          statement: 'Conscience may be fallible',
          status: 'tentative',
          established: false,
          createdAt: T,
          eventId: null,
          eventSequence: null,
          evidence: [],
        },
      ],
      gaps: [
        {
          code: 'no_evidence_recorded',
          message: 'No supporting evidence was recorded with this version.',
          versionId: VER,
          edgeId: null,
        },
      ],
    };
    reply(`GET /studies/${STUDY_ID}/nodes/${OBS}/reasoning`, jsonResponse(200, path));
    renderWithQuery(<ReasoningPath studyId={STUDY_ID} nodeId={OBS} />);
    expect(requests).toStrictEqual([]);
    fireEvent.click(screen.getByRole('button', { name: REASONING_COPY.open }));
    const region = await screen.findByRole('region', { name: REASONING_COPY.heading });
    await waitFor(() =>
      expect(textOf(region)).toContain(
        'version 1 (created, tentative) “Conscience may be fallible”',
      ),
    );
    expect(textOf(region)).toContain('No supporting evidence was recorded with this version.');
  });
});
