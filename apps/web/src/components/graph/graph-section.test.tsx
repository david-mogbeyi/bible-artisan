import type { GraphResponse, StudyResponse } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODES_COPY, NodesSection } from '@/components/nodes/nodes-section';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { GRAPH_COPY, GraphSection } from './graph-section';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const Q = '10000000-2222-4333-8444-555555555555';
const O = '20000000-2222-4333-8444-555555555555';
const S = '30000000-2222-4333-8444-555555555555';
const E1 = '90000000-2222-4333-8444-555555555555';
const T = '2026-10-02T12:00:00.000Z';

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

const summary = (id: string, type: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  origin: type === 'source' ? 'external' : 'user',
  label,
  status: type === 'question' ? 'open' : null,
  observationKind: type === 'observation' ? 'textual_observation' : null,
  referenceId: null,
  canonicalNodeId: null,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const NODES = [
  summary(Q, 'question', 'What is conscience?'),
  summary(O, 'observation', 'Paul appeals to conscience'),
  summary(S, 'source', 'A commentary'),
];

const GRAPH: GraphResponse = {
  studyId: STUDY_ID,
  contentRevision: 3,
  viewRevision: 5,
  nodes: NODES as GraphResponse['nodes'],
  edges: [{ id: E1, sourceNodeId: O, targetNodeId: Q, type: 'supports', origin: 'user' }],
  branches: [
    {
      id: '40000000-2222-4333-8444-555555555555',
      rootNodeId: Q,
      memberNodeIds: [],
      revision: 1,
      createdAt: T,
    },
  ],
  positions: [
    { nodeId: Q, x: 0, y: 0 },
    { nodeId: O, x: 0, y: 200 },
    { nodeId: S, x: 300, y: 0 },
  ],
};

type Reply = Response | Error | Promise<Response>;
/** Graph reads in order; the last one answers every later read (each a fresh Response). */
let graphReplies: (() => Reply)[];
let graphReads: number;
let patchReplies: Reply[];
let fetchMock: ReturnType<typeof vi.fn>;

function reply(next: Reply | undefined, what: string): Promise<Response> {
  if (!next) throw new Error(`unexpected ${what}`);
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
}

beforeEach(() => {
  graphReplies = [];
  graphReads = 0;
  patchReplies = [];
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const path = input.replace(/^.*\/v1/, '');
    if (path === `/studies/${STUDY_ID}/graph`) {
      const next = graphReplies[Math.min(graphReads, graphReplies.length - 1)];
      graphReads += 1;
      return reply(next?.(), 'graph');
    }
    if (path === `/studies/${STUDY_ID}/positions` && init?.method === 'PATCH') {
      return reply(patchReplies.shift(), 'position save');
    }
    if (path === `/studies/${STUDY_ID}/nodes`) {
      return Promise.resolve(jsonResponse(200, { items: NODES }));
    }
    const detail = /\/nodes\/([0-9a-f-]+)$/.exec(path)?.[1];
    if (detail) {
      const node = NODES.find((n) => n.id === detail);
      return Promise.resolve(
        jsonResponse(200, {
          id: detail,
          studyId: STUDY_ID,
          origin: node?.origin,
          canonicalNodeId: null,
          revision: 1,
          createdAt: T,
          updatedAt: T,
          ...(node?.type === 'question'
            ? { type: 'question', text: node.label, status: 'open' }
            : node?.type === 'observation'
              ? { type: 'observation', text: node.label, observationKind: 'textual_observation' }
              : {
                  type: 'source',
                  source: { title: node?.label, url: 'https://example.test/c' },
                }),
        }),
      );
    }
    if (path.startsWith(`/studies/${STUDY_ID}/edges`)) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

/** The position saves sent: their bodies and Idempotency-Keys. */
function saves(): { body: unknown; key: string }[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => ({
      body: JSON.parse(init?.body as string) as unknown,
      key: (init?.headers as Record<string, string>)['Idempotency-Key'] as string,
    }));
}

const OBS = 'Observation: Paul appeals to conscience, Textual observation';
const canvas = () => screen.getByRole('group', { name: 'Study graph' });
/** A canvas node by its accessible name (type, label and status as text). */
const canvasNode = (name: string | RegExp) => within(canvas()).getByRole('group', { name });
const status = () => screen.getByText(/^Showing \d+ of \d+ nodes/);
/** The canvas's accessible description: the text of every element its aria-describedby names. */
const description = () =>
  (canvas().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((idRef) => document.getElementById(idRef)?.textContent ?? '')
    .join(' ');

async function openGraph(study: StudyResponse = STUDY, graph: GraphResponse = GRAPH) {
  graphReplies.push(() => jsonResponse(200, graph));
  const view = renderWithQuery(
    <>
      <GraphSection study={study} />
      <NodesSection study={study} onReload={() => Promise.resolve()} />
    </>,
  );
  await screen.findByRole('group', { name: 'Study graph' });
  return view;
}

describe('GraphSection (BIB-28)', () => {
  it('shows a loading status, then every node with its type, label, origin and status as text, and each relationship in words', async () => {
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    graphReplies.push(() => pending);
    renderWithQuery(<GraphSection study={STUDY} />);
    expect(textOf(screen.getByRole('status'))).toContain(GRAPH_COPY.loading);
    act(() => answer(jsonResponse(200, GRAPH)));
    const question = await within(
      await screen.findByRole('group', { name: 'Study graph' }),
    ).findByRole('group', { name: 'Question: What is conscience?, Open' });
    expect(textOf(question)).toContain('Question');
    expect(textOf(question)).toContain('What is conscience?');
    expect(textOf(question)).toContain('You');
    expect(textOf(question)).toContain('Open');
    expect(textOf(question)).toContain('Branch root');
    expect(textOf(canvasNode(OBS))).toContain('Textual observation');
    expect(within(canvas()).getByText('supports')).toBeTruthy();
    expect(textOf(status())).toContain('Showing 3 of 3 nodes');
  });

  it('says when the graph cannot load, offers Retry, and leaves the Nodes list working', async () => {
    graphReplies.push(() =>
      jsonResponse(503, { code: 'UNAVAILABLE', message: 'x', retryable: true, correlationId: 'x' }),
    );
    renderWithQuery(
      <>
        <GraphSection study={STUDY} />
        <NodesSection study={STUDY} onReload={() => Promise.resolve()} />
      </>,
    );
    expect(
      await screen.findByText(
        /Couldn't load the graph\. The Nodes list below still has everything\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /What is conscience\?/ })).toBeTruthy();
  });

  it('shows the empty state without a canvas', async () => {
    graphReplies.push(() =>
      jsonResponse(200, { ...GRAPH, nodes: [], edges: [], branches: [], positions: [] }),
    );
    renderWithQuery(<GraphSection study={STUDY} />);
    expect(await screen.findByText(GRAPH_COPY.empty)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Study graph' })).toBeNull();
  });

  it('shares one selection with the Nodes list, in both directions, and says it in text', async () => {
    await openGraph();
    fireEvent.click(canvasNode('Question: What is conscience?, Open'));
    const listed = await screen.findByRole('button', {
      name: /What is conscience\?/,
      pressed: true,
    });
    expect(listed).toBeTruthy();
    expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected');
    expect(textOf(status())).toContain('1 selected');

    fireEvent.click(screen.getByRole('button', { name: /Paul appeals to conscience/ }));
    await waitFor(() => expect(textOf(canvasNode(OBS))).toContain('Selected'));
    expect(textOf(canvasNode('Question: What is conscience?, Open'))).not.toContain('Selected');

    // Escape clears the selection.
    fireEvent.keyDown(canvasNode(OBS), { key: 'Escape' });
    await waitFor(() => expect(textOf(status())).not.toContain('selected'));
  });

  it('saves an arrow-key move once, 300 ms after it ends, with only the moved node and the view revision, then says "Layout saved"', async () => {
    patchReplies.push(jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }));
    await openGraph();
    const node = canvasNode('Question: What is conscience?, Open');
    node.focus();
    fireEvent.keyDown(node, { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    expect(saves()).toStrictEqual([]);
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    expect(saves()).toStrictEqual([
      {
        body: { expectedRevision: 5, positions: [{ nodeId: Q, x: 10, y: 0 }] },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      },
    ]);
  });

  it('after a stale view revision refetches the graph and resends the same positions once with the new revision and a new key', async () => {
    patchReplies.push(
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'x',
        currentRevision: 7,
      }),
      jsonResponse(200, { viewRevision: 8, lastEventSequence: '12' }),
    );
    await openGraph();
    graphReplies.push(() => jsonResponse(200, { ...GRAPH, viewRevision: 7 }));
    const node = canvasNode('Question: What is conscience?, Open');
    fireEvent.keyDown(node, { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowDown' });
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    const [first, second] = saves();
    expect(first?.body).toStrictEqual({
      expectedRevision: 5,
      positions: [{ nodeId: Q, x: 0, y: 5 }],
    });
    expect(second?.body).toStrictEqual({
      expectedRevision: 7,
      positions: [{ nodeId: Q, x: 0, y: 5 }],
    });
    expect(second?.key).not.toBe(first?.key);
    expect(saves()).toHaveLength(2);
  });

  it('holds a later move while a conflict is refetching and resending, then saves it on the newer revision', async () => {
    const conflict = jsonResponse(409, {
      code: 'REVISION_CONFLICT',
      message: 'Revision conflict',
      retryable: false,
      correlationId: 'x',
      currentRevision: 7,
    });
    patchReplies.push(
      conflict,
      jsonResponse(200, { viewRevision: 8, lastEventSequence: '12' }),
      jsonResponse(200, { viewRevision: 9, lastEventSequence: '13' }),
    );
    await openGraph();
    let answer!: (response: Response) => void;
    const refetch = new Promise<Response>((resolve) => (answer = resolve));
    graphReplies.push(
      () => refetch,
      () => jsonResponse(200, { ...GRAPH, viewRevision: 9 }),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowDown' });
    await waitFor(() => expect(graphReads).toBe(2));

    // Another move while the refetch is still open: its debounce passes, but nothing is sent.
    fireEvent.keyDown(canvasNode(OBS), { key: 'Enter' });
    fireEvent.keyDown(canvasNode(OBS), { key: 'ArrowDown' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(saves()).toHaveLength(1);

    act(() => answer(jsonResponse(200, { ...GRAPH, viewRevision: 7 })));
    await waitFor(() => expect(saves()).toHaveLength(3));
    expect(saves().map((s) => s.body)).toStrictEqual([
      { expectedRevision: 5, positions: [{ nodeId: Q, x: 0, y: 5 }] },
      { expectedRevision: 7, positions: [{ nodeId: Q, x: 0, y: 5 }] },
      { expectedRevision: 8, positions: [{ nodeId: O, x: 0, y: 205 }] },
    ]);
    expect(await screen.findByText('Layout saved')).toBeTruthy();
  });

  it('stops saying "Layout saved" as soon as a new move is waiting to be saved', async () => {
    patchReplies.push(
      jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }),
      jsonResponse(200, { viewRevision: 7, lastEventSequence: '10' }),
    );
    await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowDown' });
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowDown' });
    expect(screen.queryByText('Layout saved')).toBeNull();
    expect(screen.getByText('Saving layout…')).toBeTruthy();
    expect(await screen.findByText('Layout saved')).toBeTruthy();
  });

  it('a second conflict in a row keeps the position unsaved and queued, offers Reload, and never says "Layout saved" until it is saved', async () => {
    const conflict = () =>
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'x',
        retryable: false,
        correlationId: 'x',
        currentRevision: 9,
      });
    patchReplies.push(conflict(), conflict());
    await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowLeft' });
    expect(
      await screen.findByText("Couldn't save the layout: it changed in another tab."),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(saves()).toHaveLength(2);
    expect(screen.queryByText('Layout saved')).toBeNull();

    // Moving another node later saves it together with the still-unsaved one.
    patchReplies.push(jsonResponse(200, { viewRevision: 10, lastEventSequence: '20' }));
    fireEvent.click(canvasNode(OBS));
    await waitFor(() => expect(textOf(canvasNode(OBS))).toContain('Selected'));
    fireEvent.keyDown(canvasNode(OBS), { key: 'ArrowRight' });
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    expect(saves()).toHaveLength(3);
    const third = saves()[2]?.body as { positions: { nodeId: string }[] };
    expect(third.positions.map((p) => p.nodeId).sort()).toStrictEqual([Q, O].sort());
  });

  it('settles the indicator when every node a save carried was deleted elsewhere', async () => {
    patchReplies.push(
      jsonResponse(404, { code: 'NOT_FOUND', message: 'x', retryable: false, correlationId: 'x' }),
    );
    await openGraph();
    graphReplies.push(() =>
      jsonResponse(200, {
        ...GRAPH,
        nodes: GRAPH.nodes.filter((n) => n.id !== Q),
        edges: [],
        branches: [],
        positions: GRAPH.positions.filter((p) => p.nodeId !== Q),
      }),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    expect(await screen.findByText('Some moved nodes were removed elsewhere.')).toBeTruthy();
    expect(screen.queryByText('Saving layout…')).toBeNull();
    expect(saves()).toHaveLength(1);
  });

  it('sends a move at once when the canvas unmounts within 300 ms of it', async () => {
    patchReplies.push(jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }));
    const view = await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    expect(saves()).toStrictEqual([]);
    view.unmount();
    expect(saves()).toStrictEqual([
      {
        body: { expectedRevision: 5, positions: [{ nodeId: Q, x: 5, y: 0 }] },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      },
    ]);
    const patch = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patch?.[1]?.keepalive).toBe(true);
  });

  it('sends queued moves when the page is hidden, and asks before leaving while a save is held for Retry', async () => {
    patchReplies.push(new TypeError('network'));
    await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowDown' });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(saves()).toHaveLength(1);
    expect(await screen.findByText('Layout not saved.')).toBeTruthy();
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });

  it('saves an applied arrangement in one request together with moves still waiting', async () => {
    patchReplies.push(jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }));
    await openGraph();
    const source = /^Source: A commentary/;
    fireEvent.click(canvasNode(source));
    await waitFor(() => expect(textOf(canvasNode(source))).toContain('Selected'));
    fireEvent.keyDown(canvasNode(source), { key: 'ArrowRight' });
    fireEvent.keyUp(canvasNode(source), { key: 'ArrowRight' });
    // Within the 300 ms debounce, arrange two other nodes.
    fireEvent.click(canvasNode('Question: What is conscience?, Open'));
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(document, { key: 'Shift' });
    fireEvent.click(canvasNode(OBS), { shiftKey: true });
    fireEvent.keyUp(document, { key: 'Shift' });
    await waitFor(() => expect(textOf(status())).toContain('2 selected'));
    fireEvent.click(screen.getByRole('button', { name: 'Arrange selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    expect(saves()).toHaveLength(1);
    const sent = saves()[0]?.body as { positions: { nodeId: string }[] };
    expect(sent.positions.map((p) => p.nodeId).sort()).toStrictEqual([Q, O, S].sort());
  });

  it('keeps the canvas when a background refresh fails, with a non-blocking Retry', async () => {
    const view = await openGraph();
    graphReplies.push(
      () =>
        jsonResponse(503, {
          code: 'UNAVAILABLE',
          message: 'x',
          retryable: true,
          correlationId: 'x',
        }),
      () => jsonResponse(200, GRAPH),
    );
    await act(() => view.queryClient.refetchQueries({ queryKey: ['studies', STUDY_ID, 'graph'] }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain(GRAPH_COPY.refreshFailed);
    expect(canvasNode('Question: What is conscience?, Open')).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(canvasNode('Question: What is conscience?, Open')).toBeTruthy();
  });

  it('keeps an unsaved node edit open when the canvas selection is cleared, and closes it once cancelled', async () => {
    await openGraph();
    fireEvent.click(canvasNode(OBS));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Text/ }), {
      target: { value: 'An unsaved thought' },
    });
    fireEvent.keyDown(canvasNode(OBS), { key: 'Escape' });
    await waitFor(() => expect(textOf(status())).not.toContain('selected'));
    expect(screen.getByText(NODES_COPY.held)).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^Text/ }).value).toBe(
      'An unsaved thought',
    );
    // Picking another node on the canvas keeps it open too.
    fireEvent.click(canvasNode('Question: What is conscience?, Open'));
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^Text/ }).value).toBe(
      'An unsaved thought',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Question' })).toBeTruthy();
    expect(screen.queryByText(NODES_COPY.held)).toBeNull();
  });

  it('selects the ?node= node on the canvas too, and a cleared selection does not bring it back', async () => {
    graphReplies.push(() => jsonResponse(200, GRAPH));
    renderWithQuery(
      <>
        <GraphSection study={STUDY} />
        <NodesSection study={STUDY} onReload={() => Promise.resolve()} initialNodeId={O} />
      </>,
    );
    expect(await screen.findByRole('heading', { name: 'Observation' })).toBeTruthy();
    await waitFor(() => expect(textOf(canvasNode(OBS))).toContain('Selected'));
    fireEvent.keyDown(canvasNode(OBS), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Observation' })).toBeNull());
    expect(textOf(status())).not.toContain('selected');
  });

  it('resends a save whose outcome is unknown verbatim, with the same key, on Retry', async () => {
    patchReplies.push(
      new TypeError('network'),
      jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }),
    );
    await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowUp' });
    expect(await screen.findByText('Layout not saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Layout saved')).toBeTruthy();
    const [first, second] = saves();
    expect(second).toStrictEqual(first);
  });

  it('filters node types and Sources without changing anything stored, saying how many are hidden', async () => {
    await openGraph();
    fireEvent.click(screen.getByRole('button', { name: 'Sources', pressed: true }));
    expect(textOf(status())).toContain('Showing 2 of 3 nodes · 1 hidden by filters');
    expect(within(canvas()).queryByRole('group', { name: /^Source:/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Observation' }));
    expect(textOf(status())).toContain('Showing 1 of 3 nodes · 2 hidden by filters');
    // The relationship is drawn only while both of its nodes are.
    expect(within(canvas()).queryByText('supports')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Observation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sources', pressed: false }));
    expect(textOf(status())).toContain('Showing 3 of 3 nodes');
    expect(saves()).toStrictEqual([]);
  });

  it('focuses two hops around the selected node, counts what is hidden, and Exit focus returns to all', async () => {
    await openGraph();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Focus' }).disabled).toBe(true);
    fireEvent.click(canvasNode(OBS));
    fireEvent.click(await screen.findByRole('button', { name: 'Focus' }));
    // Observation → Question (1 hop); the Source has no relationship, so it is hidden.
    expect(textOf(status())).toContain('Showing 2 of 3 nodes · 1 hidden by focus · 0 more nearby');
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(textOf(status())).toContain('Showing 2 of 3 nodes');
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(textOf(status())).toContain('Showing 3 of 3 nodes');
  });

  it('previews an arrangement of the selection, Escape cancels it (nothing saved, focus back), Apply saves exactly those nodes, and Undo restores them', async () => {
    patchReplies.push(
      jsonResponse(200, { viewRevision: 6, lastEventSequence: '9' }),
      jsonResponse(200, { viewRevision: 7, lastEventSequence: '10' }),
    );
    await openGraph();
    const arrangeButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Arrange selection',
    });
    expect(arrangeButton.disabled).toBe(true);
    fireEvent.click(canvasNode('Question: What is conscience?, Open'));
    fireEvent.keyDown(document, { key: 'Shift' });
    fireEvent.click(canvasNode(OBS), { shiftKey: true });
    fireEvent.keyUp(document, { key: 'Shift' });
    await waitFor(() => expect(textOf(status())).toContain('2 selected'));

    fireEvent.click(arrangeButton);
    expect(screen.getByText('Previewing arrangement of 2 selected nodes.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Apply' }), { key: 'Escape' });
    expect(screen.queryByText(/Previewing arrangement/)).toBeNull();
    expect(document.activeElement).toBe(arrangeButton);
    expect(saves()).toStrictEqual([]);

    fireEvent.click(arrangeButton);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(GRAPH_COPY.applied)).toBeTruthy();
    await screen.findByText('Layout saved');
    const applied = saves()[0]?.body as {
      expectedRevision: number;
      positions: { nodeId: string }[];
    };
    expect(applied.expectedRevision).toBe(5);
    expect(applied.positions.map((p) => p.nodeId).sort()).toStrictEqual([Q, O].sort());

    fireEvent.click(screen.getByRole('button', { name: 'Undo arrangement' }));
    expect(await screen.findByText(GRAPH_COPY.undone)).toBeTruthy();
    await waitFor(() => expect(saves()).toHaveLength(2));
    const undone = saves()[1]?.body as { expectedRevision: number; positions: unknown[] };
    expect(undone.expectedRevision).toBe(6);
    expect(
      [...undone.positions].sort((a, b) =>
        (a as { nodeId: string }).nodeId < (b as { nodeId: string }).nodeId ? -1 : 1,
      ),
    ).toStrictEqual([
      { nodeId: Q, x: 0, y: 0 },
      { nodeId: O, x: 0, y: 200 },
    ]);
  });

  it('keeps an archived study explorable but read-only: no moving and no Arrange', async () => {
    await openGraph({ ...STUDY, lifecycle: 'archived' });
    expect(screen.getByText(GRAPH_COPY.readOnly)).toBeTruthy();
    // The canvas's description says why it is read-only and never offers moving.
    expect(description()).toBe(`${GRAPH_COPY.readOnlyInstructions} ${GRAPH_COPY.readOnly}`);
    expect(description()).not.toContain('Arrow keys');
    expect(screen.queryByRole('button', { name: 'Arrange selection' })).toBeNull();
    const node = canvasNode('Question: What is conscience?, Open');
    expect(node.classList.contains('draggable')).toBe(false);
    fireEvent.keyDown(node, { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(saves()).toStrictEqual([]);
    // Filters still work.
    fireEvent.click(screen.getByRole('button', { name: 'Sources', pressed: true }));
    expect(textOf(status())).toContain('1 hidden by filters');
  });

  it('becomes read-only when a save finds the study archived elsewhere', async () => {
    patchReplies.push(
      jsonResponse(422, {
        code: 'STUDY_ARCHIVED',
        message: 'x',
        retryable: false,
        correlationId: 'x',
      }),
    );
    await openGraph();
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'Enter' });
    await waitFor(() =>
      expect(textOf(canvasNode('Question: What is conscience?, Open'))).toContain('Selected'),
    );
    fireEvent.keyDown(canvasNode('Question: What is conscience?, Open'), { key: 'ArrowRight' });
    expect(textOf(await screen.findByRole('alert'))).toContain(GRAPH_COPY.locked);
    expect(screen.queryByRole('button', { name: 'Arrange selection' })).toBeNull();
    expect(canvasNode('Question: What is conscience?, Open').classList.contains('draggable')).toBe(
      false,
    );
    expect(saves()).toHaveLength(1);
  });

  it('is read-only below 900 px and says the Nodes list has everything', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    graphReplies.push(() => jsonResponse(200, GRAPH));
    renderWithQuery(<GraphSection study={STUDY} />);
    // Below 900 px the section opens in List View (BIB-29); the canvas is one press away.
    fireEvent.click(await screen.findByRole('button', { name: 'Graph', pressed: false }));
    await screen.findByRole('group', { name: 'Study graph' });
    expect(screen.getByText(GRAPH_COPY.narrow)).toBeTruthy();
    expect(description()).toBe(`${GRAPH_COPY.readOnlyInstructions} ${GRAPH_COPY.narrow}`);
    expect(screen.queryByRole('button', { name: 'Arrange selection' })).toBeNull();
    expect(canvasNode('Question: What is conscience?, Open').classList.contains('draggable')).toBe(
      false,
    );
  });

  it('opens a study of more than 500 nodes focused on its main question, with Show all', async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      summary(
        `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        'thought',
        `Thought ${i}`,
      ),
    );
    const main = many[42]?.id ?? '';
    await openGraph(
      {
        ...STUDY,
        mainQuestion: {
          nodeId: main,
          text: 'Thought 42',
          status: 'open',
        },
      },
      {
        ...GRAPH,
        nodes: many as GraphResponse['nodes'],
        edges: [],
        branches: [],
        positions: [],
      },
    );
    expect(screen.getByText('This study has 501 nodes. Showing a focused view.')).toBeTruthy();
    await waitFor(() => expect(textOf(status())).toContain('Showing 1 of 501 nodes'));
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(textOf(status())).toContain('Showing 501 of 501 nodes');
  });

  it('gives every viewport action a native button', async () => {
    await openGraph();
    for (const name of ['Zoom out', 'Zoom in', 'Fit all', 'Fit selection']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('Graph overview')).toBeTruthy();
    expect(description()).toBe(GRAPH_COPY.instructions);
  });
});
