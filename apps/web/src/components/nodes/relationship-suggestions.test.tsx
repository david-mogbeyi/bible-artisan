import type { AiSuggestion, NodeSummary } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threadQueryKey } from '@/lib/thread';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { RelationshipSuggestions, SUGGESTIONS_COPY } from './relationship-suggestions';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const SCR = '10000000-2222-4333-8444-555555555555';
const THO = '20000000-2222-4333-8444-555555555555';
const SUG = '30000000-2222-4333-8444-555555555555';
const JOB = '40000000-2222-4333-8444-555555555555';
const EDGE = '50000000-2222-4333-8444-555555555555';
const T = '2026-11-15T12:00:00.000Z';

const node = (id: string, type: NodeSummary['type'], label: string): NodeSummary => ({
  id,
  type,
  origin: 'user',
  label,
  status: null,
  observationKind: null,
  referenceId: null,
  canonicalNodeId: null,
  established: false,
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
});
const NODES = [
  node(SCR, 'scripture', 'Romans 9:1'),
  node(THO, 'thought', 'Conscience bears witness'),
];

const suggestion: AiSuggestion = {
  id: SUG,
  studyId: STUDY_ID,
  capability: 'relationships',
  status: 'proposed',
  sourceNodeId: SCR,
  targetNodeId: THO,
  type: 'supports',
  rationale: 'The verse may speak of conscience bearing witness.',
  caveat: null,
  evidence: [{ id: SCR, quote: 'my conscience testifying' }],
  revision: 1,
  basisRevision: 3,
  modelId: 'fake-model-1',
  createdAt: T,
  decidedAt: null,
  acceptedEdgeId: null,
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
      if (method === 'GET' && url.pathname.endsWith('/edges')) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AI = `/studies/${STUDY_ID}/ai`;
const LIST = `${AI}/suggestions?nodeId=${SCR}`;

function open() {
  const view = renderWithQuery(
    <RelationshipSuggestions studyId={STUDY_ID} node={{ id: SCR }} nodes={NODES} />,
  );
  // Collapsed: nothing is read or requested until opened.
  expect(requests).toStrictEqual([]);
  fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS_COPY.open }));
  return view;
}

describe('RelationshipSuggestions (BIB-42)', () => {
  it('shows a proposal with its AI label, rationale and evidence, and accepts it explicitly', async () => {
    reply(
      `GET ${LIST}`,
      jsonResponse(200, { items: [suggestion] }),
      jsonResponse(200, { items: [] }),
    );
    reply(
      `POST ${AI}/suggestions/${SUG}/accept`,
      jsonResponse(200, {
        suggestionId: SUG,
        status: 'accepted',
        revision: 2,
        outcome: 'created',
        edge: {
          id: EDGE,
          sourceNodeId: SCR,
          targetNodeId: THO,
          type: 'supports',
          origin: 'ai',
          suggestionId: SUG,
          revision: 1,
        },
        lastEventSequence: '9',
      }),
    );
    open();
    const card = (await screen.findByText(SUGGESTIONS_COPY.badge)).closest('li');
    expect(textOf(card)).toContain(
      'AI suggested Scripture: Romans 9:1 supports Thought: Conscience bears witness',
    );
    expect(textOf(card)).toContain('Why: The verse may speak of conscience bearing witness.');
    expect(textOf(card)).toContain('Scripture: Romans 9:1 — “my conscience testifying”');
    const scope = within(card as HTMLElement);
    expect(scope.getByRole('button', { name: /^Edit/ })).toBeTruthy();
    expect(scope.getByRole('button', { name: /^Dismiss/ })).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: /^Accept/ }));
    await waitFor(() => expect(screen.getByText(SUGGESTIONS_COPY.accepted)).toBeTruthy());
    expect(requests.filter((r) => r.method === 'POST')).toStrictEqual([
      { method: 'POST', path: `${AI}/suggestions/${SUG}/accept`, body: { expectedRevision: 1 } },
    ]);
  });

  it('dismisses a proposal explicitly and marks the Study Thread stale, so it shows the dismissal', async () => {
    reply(
      `GET ${LIST}`,
      jsonResponse(200, { items: [suggestion] }),
      jsonResponse(200, { items: [] }),
    );
    reply(
      `POST ${AI}/suggestions/${SUG}/reject`,
      jsonResponse(200, {
        suggestionId: SUG,
        status: 'rejected',
        revision: 2,
        lastEventSequence: '9',
      }),
    );
    const { queryClient } = open();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const card = (await screen.findByText(SUGGESTIONS_COPY.badge)).closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /^Dismiss/ }));
    await waitFor(() => expect(screen.getByText(SUGGESTIONS_COPY.rejected)).toBeTruthy());
    expect(requests.filter((r) => r.method === 'POST')).toStrictEqual([
      { method: 'POST', path: `${AI}/suggestions/${SUG}/reject`, body: { expectedRevision: 1 } },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: threadQueryKey(STUDY_ID) });
  });

  it('edits the type before accepting', async () => {
    reply(`GET ${LIST}`, jsonResponse(200, { items: [suggestion] }));
    reply(
      `POST ${AI}/suggestions/${SUG}/accept`,
      jsonResponse(422, {
        code: 'AI_SUGGESTION_EXPIRED',
        message: 'never shown',
        retryable: false,
        correlationId: 'x',
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    fireEvent.change(screen.getByLabelText(SUGGESTIONS_COPY.typeLabel), {
      target: { value: 'qualifies' },
    });
    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS_COPY.acceptEdited }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      SUGGESTIONS_COPY.changed,
    );
    expect(requests.find((r) => r.method === 'POST')?.body).toStrictEqual({
      expectedRevision: 1,
      type: 'qualifies',
    });
  });

  it('asks for suggestions for the chosen node and says when AI found no clear relationship', async () => {
    reply(`GET ${LIST}`, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(
      `POST ${AI}/relationships`,
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
        capability: 'relationships',
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
          id: SUG,
          modelId: 'fake-model-1',
          promptVersion: 'p',
          output: { suggestionIds: [], suppressedCount: 0, droppedCount: 0 },
          createdAt: T,
        },
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: SUGGESTIONS_COPY.request }));
    expect(await screen.findByText(SUGGESTIONS_COPY.none)).toBeTruthy();
    expect(requests.find((r) => r.method === 'POST')?.body).toStrictEqual({
      sourceNodeId: SCR,
      targetNodeId: THO,
    });
  });

  it('points to Settings when AI is not turned on', async () => {
    reply(`GET ${LIST}`, jsonResponse(200, { items: [] }));
    reply(
      `POST ${AI}/relationships`,
      jsonResponse(422, {
        code: 'AI_CONSENT_REQUIRED',
        message: 'never shown',
        retryable: false,
        correlationId: 'x',
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: SUGGESTIONS_COPY.request }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe(`${SUGGESTIONS_COPY.consent} Open Settings`);
    expect(within(alert).getByRole('link', { name: 'Open Settings' })).toHaveProperty(
      'pathname',
      '/settings',
    );
  });
});
