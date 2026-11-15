import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_COPY } from '@/components/graph/graph-section';
import { GRAPH } from '@/test/graph-fixtures';
import { expectNoA11yViolations } from '@/test/axe';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { StudyPage } from './study-page';
import { STICKY_HEIGHT_VAR } from './workspace-tabs';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NODE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const T = '2026-10-01T12:00:00.000Z';
const STUDY = {
  id: STUDY_ID,
  title: 'Conscience and the Holy Spirit',
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
const EMPTY_GRAPH = {
  studyId: STUDY_ID,
  contentRevision: 3,
  viewRevision: 1,
  nodes: [],
  edges: [],
  branches: [],
  positions: [],
};
const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const CREATED = {
  id: NODE_ID,
  studyId: STUDY_ID,
  type: 'question',
  origin: 'user',
  revision: 1,
  referenceId: null,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '6',
  versionId: null,
  previousVersionId: null,
  warnings: [],
  outcome: 'created',
  canonicalNodeId: null,
};

let search: URLSearchParams;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ studyId: STUDY_ID }),
  useSearchParams: () => search,
}));

/** A `matchMedia` whose `(max-width: …)` queries match when `narrow` is set (jsdom has none). */
function stubViewport(narrow: boolean) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: narrow ? 390 : 1280 });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: narrow && query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

let posts: { path: string; body: unknown }[];
/** BIB-34: the saved open pane (`GET /resume`), or none. */
let savedPanes: Record<string, boolean> | null;
let viewSaves: unknown[];
let graph: { nodes: unknown[] };

beforeEach(() => {
  search = new URLSearchParams();
  graph = EMPTY_GRAPH;
  posts = [];
  savedPanes = null;
  viewSaves = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const path = new URL(input, 'http://api.test').pathname.replace(/^\/v1/, '');
      const method = init.method ?? 'GET';
      if (method === 'POST' && path === `/studies/${STUDY_ID}/nodes`) {
        posts.push({ path, body: JSON.parse(init.body as string) });
        return Promise.resolve(jsonResponse(201, { ...CREATED, studyRevision: 5 }));
      }
      if (method === 'PATCH' && path === `/studies/${STUDY_ID}/view-state`) {
        viewSaves.push(JSON.parse(init.body as string));
        return Promise.resolve(
          jsonResponse(200, {
            viewState: {
              viewRevision: 2,
              selectedNodeId: null,
              activeBranchId: null,
              activeQuestionNodeId: null,
              readerReferenceId: null,
              viewport: null,
              panes: { thread: true },
              contextSavedAt: null,
            },
            lastEventSequence: '3',
          }),
        );
      }
      if (method !== 'GET') return Promise.reject(new TypeError('unexpected write'));
      if (path === `/studies/${STUDY_ID}/resume` && savedPanes) {
        return Promise.resolve(
          jsonResponse(200, {
            studyId: STUDY_ID,
            title: 'T',
            lifecycle: 'active',
            lastActivityAt: '2026-10-01T12:00:00.000Z',
            activeQuestion: null,
            activeBranch: null,
            lastPassage: null,
            recentConclusion: null,
            openQuestions: { items: [], total: 0 },
            target: {
              kind: 'study',
              nodeId: null,
              referenceId: null,
              branchId: null,
              fallback: false,
            },
            viewState: {
              viewRevision: 1,
              selectedNodeId: null,
              activeBranchId: null,
              activeQuestionNodeId: null,
              readerReferenceId: null,
              viewport: null,
              panes: savedPanes,
              contextSavedAt: null,
            },
          }),
        );
      }
      if (path === '/me') return Promise.resolve(jsonResponse(200, ME));
      if (path === `/studies/${STUDY_ID}`) return Promise.resolve(jsonResponse(200, STUDY));
      if (path === `/studies/${STUDY_ID}/graph`) {
        return Promise.resolve(jsonResponse(200, graph));
      }
      if (path === `/studies/${STUDY_ID}/events`) {
        return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }));
      }
      if (path === `/studies/${STUDY_ID}/nodes`) {
        return Promise.resolve(jsonResponse(200, { items: graph.nodes }));
      }
      if (path === `/studies/${STUDY_ID}/notes`) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      // Everything else (summary, suggestions, node detail) is offline in these tests.
      return Promise.reject(new TypeError('offline'));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });

describe('StudyPage below 900 px (BIB-38)', () => {
  it('shows Reader, Notes, Thread, Summary and Graph Preview tabs, one panel at a time', async () => {
    stubViewport(true);
    renderWithQuery(<StudyPage />);
    const tablist = await screen.findByRole('tablist', { name: 'Study workspace' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toStrictEqual(['Reader', 'Notes', 'Thread', 'Summary', 'Graph Preview']);
    expect(tab('Reader').getAttribute('aria-selected')).toBe('true');
    // Only the selected panel is exposed; the others stay mounted but hidden.
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Reader').id);
    expect(within(panel).getByText('Starting passage')).toBeTruthy();
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(5);
    expect(screen.queryByRole('heading', { name: 'Nodes' })).toBeNull();
    await expectNoA11yViolations(document.body);

    fireEvent.click(tab('Thread'));
    expect(tab('Thread').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('Thread').id);
    expect(
      screen.getByText('Starting passage').closest('[role="tabpanel"]')?.hasAttribute('hidden'),
    ).toBe(true);
  });

  it('reopens the pane saved in the view state, and saves the tab the user picks (BIB-34)', async () => {
    stubViewport(true);
    savedPanes = { summary: true };
    renderWithQuery(<StudyPage />);
    await screen.findByRole('tablist', { name: 'Study workspace' });
    await waitFor(() => expect(tab('Summary').getAttribute('aria-selected')).toBe('true'));
    expect(viewSaves).toStrictEqual([]);

    fireEvent.click(tab('Thread'));
    await waitFor(() => expect(viewSaves).toHaveLength(1), { timeout: 3000 });
    expect(viewSaves).toStrictEqual([{ expectedRevision: 1, panes: { thread: true } }]);
  });

  it('keeps the sticky tab list height as page scroll padding, so focus is never hidden under it (BIB-53)', async () => {
    stubViewport(true);
    const { unmount } = renderWithQuery(<StudyPage />);
    const tablist = await screen.findByRole('tablist', { name: 'Study workspace' });
    const root = document.documentElement;
    expect(root.style.getPropertyValue(STICKY_HEIGHT_VAR)).toBe(`${tablist.offsetHeight}px`);
    unmount();
    expect(root.style.getPropertyValue(STICKY_HEIGHT_VAR)).toBe('');
  });

  it('moves between tabs with the arrow keys, Home and End, keeping one tab in the Tab order', async () => {
    stubViewport(true);
    renderWithQuery(<StudyPage />);
    const tablist = await screen.findByRole('tablist', { name: 'Study workspace' });
    tab('Reader').focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Notes'));
    expect(tab('Notes').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(document.activeElement).toBe(tab('Graph Preview'));
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Reader'));
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Graph Preview'));
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(document.activeElement).toBe(tab('Reader'));
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.tabIndex),
    ).toStrictEqual([0, -1, -1, -1, -1]);
  });

  it('captures a question from the Notes tab without the canvas', async () => {
    stubViewport(true);
    renderWithQuery(<StudyPage />);
    await screen.findByRole('tablist', { name: 'Study workspace' });
    // The graph preview has no canvas to drag (an empty study; List View is graph-list-view's).
    fireEvent.click(tab('Graph Preview'));
    expect(await within(screen.getByRole('tabpanel')).findByText(GRAPH_COPY.empty)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Study graph', hidden: true })).toBeNull();

    fireEvent.click(tab('Notes'));
    const panel = screen.getByRole('tabpanel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Add node' }));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Question' }));
    fireEvent.change(within(panel).getByLabelText('Statement'), {
      target: { value: 'What is conscience?' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(posts).toStrictEqual([
        {
          path: `/studies/${STUDY_ID}/nodes`,
          body: { type: 'question', expectedRevision: 4, text: 'What is conscience?' },
        },
      ]),
    );
    expect(await within(panel).findByText(/Added .* to the study\.|Question added/)).toBeTruthy();
  });

  it("switches to the Notes tab when Graph Preview's List View opens a node's detail", async () => {
    stubViewport(true);
    graph = GRAPH;
    renderWithQuery(<StudyPage />);
    await screen.findByRole('tablist', { name: 'Study workspace' });
    fireEvent.click(tab('Graph Preview'));
    const panel = screen.getByRole('tabpanel');
    fireEvent.click(await within(panel).findByRole('button', { name: /^Open Question/ }));
    expect(tab('Notes').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('Notes').id);
  });

  it('opens on the Notes tab when the link names a node', async () => {
    stubViewport(true);
    search = new URLSearchParams({ node: NODE_ID });
    renderWithQuery(<StudyPage />);
    await screen.findByRole('tablist', { name: 'Study workspace' });
    expect(tab('Notes').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the desktop layout at 900 px and wider: no tabs, every region shown', async () => {
    stubViewport(false);
    renderWithQuery(<StudyPage />);
    await screen.findByRole('heading', { level: 1, name: 'Conscience and the Holy Spirit' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByText('Starting passage')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Nodes' })).toBeTruthy();
    await expectNoA11yViolations(document.body);
  });
});
