import type { GraphResponse, NodeSummary, StudyResponse } from '@bible-artisan/contracts';
import { vi } from 'vitest';
import { jsonResponse } from './render';

/**
 * A small study graph and a stubbed API for the Graph section's List View and Connect dialog
 * tests (BIB-29): the snapshot, the Nodes list, node detail, relationship lists and edge creation.
 */

export const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
export const Q = '10000000-2222-4333-8444-555555555555';
export const O = '20000000-2222-4333-8444-555555555555';
export const S = '30000000-2222-4333-8444-555555555555';
export const D = '40000000-2222-4333-8444-555555555555';
export const C = '50000000-2222-4333-8444-555555555555';
export const E1 = 'e1000000-2222-4333-8444-555555555555';
export const E2 = 'e2000000-2222-4333-8444-555555555555';
export const NEW_EDGE = 'e9000000-2222-4333-8444-555555555555';
const T = '2026-10-02T12:00:00.000Z';

export const STUDY: StudyResponse = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 4,
  contentRevision: 3,
  startingReference: null,
  mainQuestion: null,
  originalQuestion: null,
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: T,
};

const summary = (
  id: string,
  type: NodeSummary['type'],
  label: string,
  extra: Partial<NodeSummary> = {},
): NodeSummary => ({
  id,
  type,
  origin: type === 'source' ? 'external' : type === 'scripture' ? 'scripture' : 'user',
  label,
  status: type === 'question' ? 'open' : null,
  observationKind: type === 'observation' ? 'textual_observation' : null,
  referenceId: null,
  canonicalNodeId: null,
  established: false,
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

/** In snapshot order. D is a deliberate duplicate of S (BIB-26). */
export const NODES: NodeSummary[] = [
  summary(Q, 'question', 'What is conscience?'),
  summary(O, 'observation', 'Paul appeals to conscience'),
  summary(S, 'scripture', 'Romans 9:1'),
  summary(D, 'scripture', 'Romans 9:1', { canonicalNodeId: S }),
  summary(C, 'source', 'A commentary'),
];

/** O supports Q (directed); O is related to C (two-way). */
export const GRAPH: GraphResponse = {
  studyId: STUDY_ID,
  contentRevision: 3,
  viewRevision: 5,
  nodes: NODES,
  edges: [
    { id: E1, sourceNodeId: O, targetNodeId: Q, type: 'supports', origin: 'user' },
    { id: E2, sourceNodeId: O, targetNodeId: C, type: 'related_to', origin: 'user' },
  ],
  branches: [],
  positions: [
    { nodeId: Q, x: 0, y: 0 },
    { nodeId: O, x: 0, y: 200 },
    { nodeId: S, x: 300, y: 0 },
    { nodeId: D, x: 300, y: 200 },
    { nodeId: C, x: 600, y: 0 },
  ],
};

function nodeDetail(node: NodeSummary | undefined) {
  const common = {
    id: node?.id,
    studyId: STUDY_ID,
    origin: node?.origin,
    canonicalNodeId: node?.canonicalNodeId ?? null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
  };
  switch (node?.type) {
    case 'question':
      return { ...common, type: 'question', text: node.label, status: 'open' };
    case 'observation':
      return {
        ...common,
        type: 'observation',
        text: node.label,
        observationKind: 'textual_observation',
      };
    case 'scripture':
      return { ...common, type: 'scripture', reference: null };
    default:
      return {
        ...common,
        type: 'source',
        source: {
          title: node?.label,
          kind: 'commentary',
          author: null,
          workTitle: null,
          publicationDetails: null,
          url: 'https://example.test/c',
          locator: null,
          excerpt: null,
          excerptKind: null,
        },
      };
  }
}

export interface Sent {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

type Reply = Response | Error | Promise<Response>;

/**
 * Stubs `fetch` for a study page's graph. `graph` answers every snapshot read (replace it to
 * change what the next read returns); `edgeReplies` answer `POST /edges` in order, and
 * `branchReplies` answer `POST /branches` and `PATCH /branches/:id/members` (BIB-60) in order;
 * `positionReplies` answer `PATCH /positions` (a 200 with the next view revision when none is
 * queued). `requests` logs every call; `graphReads` counts snapshot reads.
 */
export function stubGraphApi() {
  const api = {
    graph: GRAPH,
    edgeReplies: [] as Reply[],
    branchReplies: [] as Reply[],
    positionReplies: [] as Reply[],
    viewRevision: GRAPH.viewRevision,
    requests: [] as Sent[],
    graphReads: 0,
    mutations: () => api.requests.filter((r) => r.method !== 'GET'),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      api.requests.push({
        method,
        path,
        body: init.body ? (JSON.parse(init.body as string) as unknown) : undefined,
        key: headers['Idempotency-Key'],
      });
      const study = `/studies/${STUDY_ID}`;
      if (method === 'GET' && path === `${study}/graph`) {
        api.graphReads += 1;
        return Promise.resolve(jsonResponse(200, api.graph));
      }
      if (method === 'GET' && path === `${study}/nodes`) {
        return Promise.resolve(jsonResponse(200, { items: api.graph.nodes }));
      }
      const detail = /\/nodes\/([0-9a-f-]+)$/.exec(url.pathname)?.[1];
      if (method === 'GET' && detail) {
        const node = api.graph.nodes.find((n) => n.id === detail);
        return Promise.resolve(jsonResponse(200, nodeDetail(node)));
      }
      if (method === 'GET' && url.pathname.endsWith('/edges')) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      if (method === 'POST' && path === `${study}/edges`) {
        const next = api.edgeReplies.shift();
        if (!next) return Promise.reject(new Error('unexpected edge create'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      if (
        (method === 'POST' && path === `${study}/branches`) ||
        (method === 'PATCH' && /\/branches\/[^/]+\/members$/.test(url.pathname))
      ) {
        const next = api.branchReplies.shift();
        if (!next) return Promise.reject(new Error('unexpected branch change'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      if (method === 'PATCH' && path === `${study}/positions`) {
        const next = api.positionReplies.shift();
        if (next) return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        api.viewRevision += 1;
        return Promise.resolve(
          jsonResponse(200, { viewRevision: api.viewRevision, lastEventSequence: '20' }),
        );
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    }),
  );
  return api;
}

/** The server's 201 for a new relationship. */
export function createdEdge(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
  outcome: 'created' | 'existing' = 'created',
) {
  return jsonResponse(outcome === 'created' ? 201 : 200, {
    id: NEW_EDGE,
    studyId: STUDY_ID,
    sourceNodeId,
    targetNodeId,
    type,
    origin: 'user',
    revision: 1,
    createdAt: T,
    updatedAt: T,
    lastEventSequence: outcome === 'created' ? '12' : null,
    outcome,
    studyRevision: outcome === 'created' ? 5 : 4,
  });
}

export const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});
