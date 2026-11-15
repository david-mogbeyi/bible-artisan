import type { StudyResponse } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { NODE_ACTION_COPY } from './node-actions';
import { NodesSection } from './nodes-section';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const OBS = 'bbbbbbbb-2222-4333-8444-555555555551';
const CON = 'bbbbbbbb-2222-4333-8444-555555555552';
const COPY = 'bbbbbbbb-2222-4333-8444-555555555553';
const EDGE = 'eeeeeeee-2222-4333-8444-555555555551';
const T = '2026-10-01T12:00:00.000Z';
const STUDY: StudyResponse = {
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

const summary = (overrides: Record<string, unknown>) => ({
  origin: 'user',
  status: null,
  observationKind: null,
  referenceId: null,
  canonicalNodeId: null,
  established: false,
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});
const OBS_SUMMARY = summary({
  id: OBS,
  type: 'observation',
  label: 'Paul appeals',
  observationKind: 'textual_observation',
});
const CON_SUMMARY = summary({
  id: CON,
  type: 'conclusion',
  label: 'Conscience bears witness',
  status: 'supported',
  established: true,
  revision: 3,
});
const common = (id: string, revision = 1) => ({
  id,
  studyId: STUDY_ID,
  origin: 'user',
  canonicalNodeId: null,
  revision,
  createdAt: T,
  updatedAt: T,
});
const OBSERVATION = {
  type: 'observation',
  ...common(OBS),
  text: 'Paul appeals',
  observationKind: 'textual_observation',
  establishedAt: null,
  derivedFromNote: null,
};
const CONCLUSION = {
  type: 'conclusion',
  ...common(CON, 3),
  text: 'Conscience bears witness',
  status: 'supported',
  establishedAt: T,
  evidenceIncomplete: false,
  liveEvidenceCount: 1,
  version: { id: 'cccccccc-2222-4333-8444-555555555551', number: 3 },
};
const GRAPH = {
  studyId: STUDY_ID,
  contentRevision: 3,
  viewRevision: 1,
  nodes: [OBS_SUMMARY, CON_SUMMARY],
  edges: [{ id: EDGE, sourceNodeId: OBS, targetNodeId: CON, type: 'supports', origin: 'user' }],
  branches: [],
  positions: [],
};
const mutation = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  studyId: STUDY_ID,
  type: 'observation',
  origin: 'user',
  revision: 2,
  referenceId: null,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '9',
  versionId: null,
  previousVersionId: null,
  warnings: [],
  ...overrides,
});

type Reply = Response | Promise<Response>;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown; key: string | undefined }[];

function reply(route: string, ...answers: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);
}

const NODES = `/studies/${STUDY_ID}/nodes`;

beforeEach(() => {
  replies = new Map();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        key: headers['Idempotency-Key'],
      });
      if (method === 'GET' && path === '/bible/translations') {
        return Promise.resolve(jsonResponse(200, { translations: [TRANSLATION] }));
      }
      const next = replies.get(`${method} ${path}`)?.shift();
      if (next) return Promise.resolve(next);
      if (method === 'GET' && path.startsWith(`/studies/${STUDY_ID}/edges?`)) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      if (method === 'GET' && path === `/studies/${STUDY_ID}/graph`) {
        return Promise.resolve(jsonResponse(200, GRAPH));
      }
      if (method === 'GET' && path === NODES) {
        return Promise.resolve(jsonResponse(200, { items: [OBS_SUMMARY, CON_SUMMARY] }));
      }
      if (method === 'GET' && path.startsWith(`${NODES}/`) && path.endsWith('/versions')) {
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

const sent = (method: string) => requests.filter((r) => r.method === method);

async function openNode(name: string, heading: string) {
  renderWithQuery(<NodesSection study={STUDY} onReload={() => Promise.resolve()} />);
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('region', { name: heading });
}

describe('node detail actions', () => {
  it("marks an observation 'Established by me' (BIB-62): the PATCH sends the marker alone with a key, and the marker reads as text", async () => {
    reply(
      `GET ${NODES}/${OBS}`,
      jsonResponse(200, OBSERVATION),
      jsonResponse(200, { ...OBSERVATION, revision: 2, establishedAt: T }),
    );
    reply(`PATCH ${NODES}/${OBS}`, jsonResponse(200, mutation(OBS)));
    const detail = await openNode(
      'Observation · You · Textual observation Paul appeals',
      'Observation',
    );
    fireEvent.click(within(detail).getByRole('button', { name: NODE_ACTION_COPY.mark }));
    expect(
      await within(detail).findByRole('button', { name: NODE_ACTION_COPY.unmark }),
    ).toBeTruthy();
    const [patch] = sent('PATCH');
    expect(patch).toStrictEqual({
      method: 'PATCH',
      path: `${NODES}/${OBS}`,
      body: { expectedRevision: 1, establishment: 'set' },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(textOf(detail)).toContain(NODE_ACTION_COPY.establishedHelp);
    expect(screen.getByText(NODE_ACTION_COPY.marked)).toBeTruthy();
  });

  it('duplicates a conclusion (BIB-61): the study revision with a key, then the copy is selected, focused and announced', async () => {
    reply(`GET ${NODES}/${CON}`, jsonResponse(200, CONCLUSION));
    reply(
      `POST ${NODES}/${CON}/duplicate`,
      jsonResponse(201, {
        ...mutation(COPY, { type: 'conclusion', revision: 1 }),
        versionId: 'cccccccc-2222-4333-8444-555555555559',
        studyRevision: 5,
        duplicateOfNodeId: CON,
      }),
    );
    reply(
      `GET ${NODES}/${COPY}`,
      jsonResponse(200, {
        ...CONCLUSION,
        ...common(COPY),
        status: 'tentative',
        establishedAt: null,
        liveEvidenceCount: 0,
        version: { id: 'cccccccc-2222-4333-8444-555555555559', number: 1 },
      }),
    );
    const detail = await openNode(
      'Conclusion · You · Supported · Established by me Conscience bears witness',
      'Conclusion',
    );
    fireEvent.click(within(detail).getByRole('button', { name: 'Duplicate Conclusion' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Conclusion'));
    expect(sent('POST')).toStrictEqual([
      {
        method: 'POST',
        path: `${NODES}/${CON}/duplicate`,
        body: { expectedRevision: 4 },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(
      screen.getByText(
        "Duplicated Conclusion. The copy has no relationships. It starts Tentative, without 'Established by me'.",
      ),
    ).toBeTruthy();
  });

  it('deletes through a dialog that states the impact first (BIB-31), then restores from the status', async () => {
    reply(`GET ${NODES}/${OBS}`, jsonResponse(200, OBSERVATION));
    reply(
      `DELETE ${NODES}/${OBS}`,
      jsonResponse(200, {
        id: OBS,
        studyId: STUDY_ID,
        type: 'observation',
        revision: 2,
        removedEdgeCount: 1,
        promotedCanonicalNodeId: null,
        mainQuestionCleared: false,
        establishmentClearedNodeIds: [CON],
        lastEventSequence: '10',
      }),
    );
    reply(
      `POST ${NODES}/${OBS}/restore`,
      jsonResponse(200, {
        ...mutation(OBS, { revision: 3 }),
        canonicalNodeId: null,
        restoredEdgeIds: [EDGE],
        skippedEdges: [],
        establishmentClearedNodeIds: [],
      }),
    );
    const detail = await openNode(
      'Observation · You · Textual observation Paul appeals',
      'Observation',
    );
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete node…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this node?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(textOf(dialog)).toContain('Its 1 relationship is removed with it.'));
    expect(textOf(dialog)).toContain(
      "Conclusion: Conscience bears witness — it will have no remaining evidence and will lose 'Established by me'",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByText(
        "Deleted Observation: Paul appeals. 'Established by me' was cleared on 1 conclusion that lost their last evidence.",
      ),
    ).toBeTruthy();
    expect(sent('DELETE')).toStrictEqual([
      {
        method: 'DELETE',
        path: `${NODES}/${OBS}`,
        body: { expectedRevision: 1 },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    reply(`GET ${NODES}/${OBS}`, jsonResponse(200, { ...OBSERVATION, revision: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByText('Restored Observation: Paul appeals. 1 relationship restored.'),
    ).toBeTruthy();
    expect(sent('POST').at(-1)).toStrictEqual({
      method: 'POST',
      path: `${NODES}/${OBS}/restore`,
      body: { expectedRevision: 2 },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('hides the marker, Duplicate and Delete on a read-only study but still shows the marker text', async () => {
    reply(`GET ${NODES}/${OBS}`, jsonResponse(200, { ...OBSERVATION, establishedAt: T }));
    renderWithQuery(
      <NodesSection
        study={{ ...STUDY, lifecycle: 'archived' }}
        onReload={() => Promise.resolve()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Observation · You · Textual observation Paul appeals',
      }),
    );
    const detail = await screen.findByRole('region', { name: 'Observation' });
    expect(textOf(detail)).toContain(NODE_ACTION_COPY.establishedHelp);
    for (const name of [
      NODE_ACTION_COPY.mark,
      NODE_ACTION_COPY.unmark,
      'Duplicate Observation',
      'Delete node…',
    ]) {
      expect(within(detail).queryByRole('button', { name })).toBeNull();
    }
  });
});
