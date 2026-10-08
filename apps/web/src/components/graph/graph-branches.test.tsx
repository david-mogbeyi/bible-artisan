import type { Branch, GraphResponse, StudyResponse } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODES_COPY, NodesSection } from '@/components/nodes/nodes-section';
import { expectNoA11yViolations } from '@/test/axe';
import { C, D, envelope, GRAPH, O, Q, S, STUDY, stubGraphApi } from '@/test/graph-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { GRAPH_COPY, GraphSection } from './graph-section';
import { LIST_VIEW_COPY } from './graph-list-view';
import { BRANCH_COPY } from './use-branch-members';

const A = 'b1000000-2222-4333-8444-555555555555';
const B = 'b2000000-2222-4333-8444-555555555555';
const NEW = 'b9000000-2222-4333-8444-555555555555';
const T = '2026-10-02T12:00:00.000Z';
const LABEL_A = 'Branch: Question: What is conscience?';
const LABEL_B = 'Branch: Scripture: Romans 9:1';

/** Branch A: root Q, members O and D. Branch B: root S, member D (shared with A). */
const BRANCHES: GraphResponse['branches'] = [
  { id: A, rootNodeId: Q, memberNodeIds: [O, D], revision: 3, createdAt: T },
  { id: B, rootNodeId: S, memberNodeIds: [D], revision: 1, createdAt: '2026-10-02T12:30:00.000Z' },
];
const WITH_BRANCHES: GraphResponse = { ...GRAPH, branches: BRANCHES };

/** The Nodes list's button for a node (type, origin and state, then the label). */
const NODE_BUTTONS: Record<string, string> = {
  [Q]: 'Question · You · Open What is conscience?',
  [O]: 'Observation · You · Textual observation Paul appeals to conscience',
  [S]: 'Scripture · Scripture Text Romans 9:1',
  [D]: 'Scripture · Scripture Text · Duplicate Romans 9:1',
  [C]: 'Source · External Source A commentary',
};

let api: ReturnType<typeof stubGraphApi>;

beforeEach(() => {
  api = stubGraphApi();
  api.graph = WITH_BRANCHES;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const status = () => screen.getByText(/^Showing \d+ of \d+ nodes/);
const canvas = () => screen.getByRole('group', { name: 'Study graph' });
const canvasNode = (name: string | RegExp) => within(canvas()).getByRole('group', { name });
const branchChanges = () =>
  api.requests
    .filter((r) => r.path.includes('/branches'))
    .map(({ method, path, body, key }) => ({
      method,
      path,
      body,
      key,
    }));
const positionSaves = () => api.requests.filter((r) => r.path.endsWith('/positions'));
const membersPath = (branchId: string) => `/studies/${STUDY.id}/branches/${branchId}/members`;

async function openPage(study: StudyResponse = STUDY) {
  const view = renderWithQuery(
    <>
      <GraphSection study={study} />
      <NodesSection study={study} onReload={() => Promise.resolve()} />
    </>,
  );
  await screen.findByRole('group', { name: 'Study graph' });
  return view;
}

function openMenu() {
  fireEvent.click(screen.getByText('Branches', { selector: 'summary' }));
}

/** Opens a node's detail from the Nodes list and returns its Branches group. */
async function openBranches(nodeId: string) {
  fireEvent.click(screen.getByRole('button', { name: NODE_BUTTONS[nodeId] }));
  const group = await screen.findByRole('group', { name: 'Branches' });
  await within(group).findAllByText(/Branch:|No branches yet/);
  return group;
}

const branchResponse = (branch: Branch, sequence = '15') =>
  jsonResponse(200, { ...branch, lastEventSequence: sequence });

describe('canvas toolbar Branches (BIB-60)', () => {
  it('lists each branch with its node count, and collapse hides only exclusive members, says "+N hidden" on the root and counts them, changing nothing stored', async () => {
    await openPage();
    openMenu();
    expect(screen.getByText(`${LABEL_A} (3 nodes)`)).toBeTruthy();
    expect(screen.getByText(`${LABEL_B} (2 nodes)`)).toBeTruthy();

    const collapseA = screen.getByRole('button', { name: `Collapse ${LABEL_A}` });
    expect(collapseA.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(collapseA);
    expect(collapseA.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(`${LABEL_A} (3 nodes) · collapsed`)).toBeTruthy();
    // O is only in A: hidden. D is shared with B (open): it stays. The root stays.
    await waitFor(() =>
      expect(textOf(status())).toBe('Showing 4 of 5 nodes · 1 in collapsed branches'),
    );
    const root = canvasNode('Question: What is conscience?, Open, 1 hidden');
    expect(textOf(root)).toContain('+1 hidden');
    expect(within(canvas()).queryByRole('group', { name: /Paul appeals/ })).toBeNull();
    expect(
      within(canvas()).getByRole('group', { name: /^Scripture: Romans 9:1 \(duplicate\)/ }),
    ).toBeTruthy();

    // Both collapsed: D is in two collapsed branches, so it hides too; both roots stay.
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${LABEL_B}` }));
    await waitFor(() =>
      expect(textOf(status())).toBe('Showing 3 of 5 nodes · 2 in collapsed branches'),
    );
    expect(textOf(canvasNode(/^Question: What is conscience\?, Open, 2 hidden/))).toContain(
      '+2 hidden',
    );
    expect(textOf(canvasNode(/^Scripture: Romans 9:1, 1 hidden/))).toContain('+1 hidden');

    // List View honors the same visibility.
    fireEvent.click(screen.getByRole('button', { name: 'List', pressed: false }));
    await screen.findByRole('heading', { name: LIST_VIEW_COPY.heading });
    expect(screen.getAllByRole('checkbox', { name: /^Select / })).toHaveLength(3);

    // Expanding again shows everything; nothing was ever sent.
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${LABEL_A}` }));
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${LABEL_B}` }));
    await waitFor(() => expect(textOf(status())).toBe('Showing 5 of 5 nodes'));
    expect(api.mutations()).toStrictEqual([]);
  });

  it('shows only one branch, switches between branches, and Show all returns, sending nothing', async () => {
    await openPage();
    openMenu();
    const soloB = screen.getByRole('button', { name: `Show only ${LABEL_B}` });
    fireEvent.click(soloB);
    expect(soloB.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(textOf(status())).toBe(`Showing 2 of 5 nodes · 3 outside ${LABEL_B}`),
    );
    expect(within(canvas()).queryByRole('group', { name: /^Question/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Show only ${LABEL_A}` }));
    expect(soloB.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() =>
      expect(textOf(status())).toBe(`Showing 3 of 5 nodes · 2 outside ${LABEL_A}`),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(textOf(status())).toBe('Showing 5 of 5 nodes'));
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(api.mutations()).toStrictEqual([]);
  });

  it('arranges a branch: preview names it, Escape cancels to its Arrange button, Apply saves exactly its nodes with the root in place, and Undo restores them', async () => {
    await openPage();
    openMenu();
    const arrangeA = screen.getByRole<HTMLButtonElement>('button', { name: `Arrange ${LABEL_A}` });
    fireEvent.click(arrangeA);
    expect(screen.getByText(`Previewing arrangement of ${LABEL_A} (3 nodes).`)).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(document.activeElement).toBe(apply);
    fireEvent.keyDown(apply, { key: 'Escape' });
    expect(screen.queryByText(/Previewing arrangement/)).toBeNull();
    expect(document.activeElement).toBe(arrangeA);
    expect(positionSaves()).toStrictEqual([]);

    fireEvent.click(arrangeA);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(GRAPH_COPY.applied)).toBeTruthy();
    await screen.findByText('Layout saved');
    const applied = positionSaves()[0]?.body as {
      positions: { nodeId: string; x: number; y: number }[];
    };
    expect(applied.positions.map((p) => p.nodeId).sort()).toStrictEqual([Q, O, D].sort());
    // The root keeps its position.
    expect(applied.positions.find((p) => p.nodeId === Q)).toStrictEqual({ nodeId: Q, x: 0, y: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Undo arrangement' }));
    await waitFor(() => expect(positionSaves()).toHaveLength(2));
    const undone = positionSaves()[1]?.body as { positions: { nodeId: string }[] };
    expect([...undone.positions].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))).toStrictEqual(
      [
        { nodeId: Q, x: 0, y: 0 },
        { nodeId: O, x: 0, y: 200 },
        { nodeId: D, x: 300, y: 200 },
      ].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
    );
  });

  it('adds the selected nodes to a chosen branch in one request and says how many were added; nothing to add says so', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'List', pressed: false }));
    await screen.findByRole('heading', { name: LIST_VIEW_COPY.heading });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Observation: Paul appeals to conscience' }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Source: A commentary' }));
    openMenu();
    const group = screen.getByRole('group', { name: 'Add 2 selected to branch' });
    fireEvent.change(within(group).getByRole('combobox', { name: 'Branch' }), {
      target: { value: B },
    });
    api.branchReplies.push(
      branchResponse({ ...BRANCHES[1], memberNodeIds: [D, O, C], revision: 2 } as Branch),
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(`Added 2 nodes to ${LABEL_B}.`)).toBeTruthy();
    expect(branchChanges()).toStrictEqual([
      {
        method: 'PATCH',
        path: membersPath(B),
        body: { expectedRevision: 1, add: [O, C] },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      },
    ]);

    api.branchReplies.push(jsonResponse(422, envelope('BRANCH_UNCHANGED')));
    fireEvent.click(within(group).getByRole('button', { name: 'Add' }));
    expect(textOf(await within(group).findByRole('alert'))).toBe(
      'Nothing to change in this branch.',
    );
  });

  it('keeps an archived study explorable: branches listed, collapse and show only work, but no Arrange and no Add', async () => {
    await openPage({ ...STUDY, lifecycle: 'archived' });
    openMenu();
    expect(screen.queryByRole('button', { name: `Arrange ${LABEL_A}` })).toBeNull();
    expect(screen.queryByRole('group', { name: /selected to branch/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${LABEL_A}` }));
    await waitFor(() =>
      expect(textOf(status())).toBe('Showing 4 of 5 nodes · 1 in collapsed branches'),
    );
    fireEvent.click(screen.getByRole('button', { name: `Show only ${LABEL_B}` }));
    await waitFor(() => expect(textOf(status())).toContain(`3 outside ${LABEL_B}`));
  });

  it('has no WCAG A/AA violations in the open Branches disclosure and the node detail Branches group', async () => {
    await openPage();
    openMenu();
    const menu = screen.getByText('Branches', { selector: 'summary' }).closest('details');
    await expectNoA11yViolations(menu as Element);
    await expectNoA11yViolations(await openBranches(O));
  });

  it('says when there are no branches yet', async () => {
    api.graph = GRAPH;
    await openPage();
    openMenu();
    expect(screen.getByText(BRANCH_COPY.toolbarEmpty)).toBeTruthy();
  });
});

describe('node detail Branches (BIB-60)', () => {
  it('ticks and unticks a branch: one request each with that branch revision and an Idempotency-Key, announced, the box showing the server state', async () => {
    await openPage();
    const group = await openBranches(O);
    const boxA = within(group).getByRole<HTMLInputElement>('checkbox', { name: LABEL_A });
    const boxB = within(group).getByRole<HTMLInputElement>('checkbox', { name: LABEL_B });
    expect([boxA.checked, boxB.checked]).toStrictEqual([true, false]);

    // The server's state after each change, for the refetch that follows it.
    const [branchA, branchB] = BRANCHES as [Branch, Branch];
    const addedB = { ...branchB, memberNodeIds: [D, O], revision: 2 };
    api.branchReplies.push(branchResponse(addedB));
    api.graph = { ...WITH_BRANCHES, branches: [branchA, addedB] };
    fireEvent.click(boxB);
    expect(await within(group).findByText(`Added to ${LABEL_B}.`)).toBeTruthy();
    expect(boxB.checked).toBe(true);

    const removedA = { ...branchA, memberNodeIds: [D], revision: 4 };
    api.branchReplies.push(branchResponse(removedA));
    api.graph = { ...WITH_BRANCHES, branches: [removedA, addedB] };
    fireEvent.click(boxA);
    expect(await within(group).findByText(`Removed from ${LABEL_A}.`)).toBeTruthy();
    await waitFor(() => expect(boxA.checked).toBe(false));
    const sent = branchChanges();
    expect(sent.map(({ method, path, body }) => ({ method, path, body }))).toStrictEqual([
      { method: 'PATCH', path: membersPath(B), body: { expectedRevision: 1, add: [O] } },
      { method: 'PATCH', path: membersPath(A), body: { expectedRevision: 3, remove: [O] } },
    ]);
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });

  it("shows the node's own branch checked and unavailable with (root), and offers no start for a root or a non-question, non-passage node", async () => {
    await openPage();
    const rootGroup = await openBranches(Q);
    const root = within(rootGroup).getByRole<HTMLInputElement>('checkbox', {
      name: `${LABEL_A} (root)`,
    });
    expect([root.checked, root.getAttribute('aria-disabled')]).toStrictEqual([true, 'true']);
    fireEvent.click(root);
    expect(within(rootGroup).queryByRole('button', { name: 'Start a branch here' })).toBeNull();
    const observation = await openBranches(O);
    expect(within(observation).queryByRole('button', { name: 'Start a branch here' })).toBeNull();
    expect(branchChanges()).toStrictEqual([]);
  });

  it('starts a branch at an unrooted passage with the study revision, announces it and moves focus to its root checkbox', async () => {
    await openPage();
    const group = await openBranches(D);
    const created = { id: NEW, rootNodeId: D, memberNodeIds: [], revision: 1, createdAt: T };
    api.branchReplies.push(
      jsonResponse(201, {
        ...created,
        studyId: STUDY.id,
        studyRevision: 5,
        lastEventSequence: '16',
      }),
    );
    api.graph = { ...WITH_BRANCHES, branches: [...BRANCHES, created] };
    fireEvent.click(within(group).getByRole('button', { name: 'Start a branch here' }));
    expect(await within(group).findByText(BRANCH_COPY.started)).toBeTruthy();
    const box = await within(group).findByRole<HTMLInputElement>('checkbox', {
      name: 'Branch: Scripture: Romans 9:1 (duplicate) (root)',
    });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.checked).toBe(true);
    expect(within(group).queryByRole('button', { name: 'Start a branch here' })).toBeNull();
    expect(branchChanges().map(({ method, body }) => ({ method, body }))).toStrictEqual([
      { method: 'POST', body: { expectedRevision: STUDY.revision, rootNodeId: D } },
    ]);
  });

  it('a stale branch says so and refetches; nothing to change refetches silently; a stale study asks to start again', async () => {
    await openPage();
    const group = await openBranches(O);
    const reads = api.graphReads;
    api.branchReplies.push(
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })),
    );
    fireEvent.click(within(group).getByRole('checkbox', { name: LABEL_B }));
    expect(textOf(await within(group).findByRole('alert'))).toBe(BRANCH_COPY.conflict);
    await waitFor(() => expect(api.graphReads).toBeGreaterThan(reads));

    const before = api.graphReads;
    api.branchReplies.push(jsonResponse(422, envelope('BRANCH_UNCHANGED')));
    fireEvent.click(within(group).getByRole('checkbox', { name: LABEL_B }));
    await waitFor(() => expect(api.graphReads).toBeGreaterThan(before));
    expect(within(group).queryByRole('alert')).toBeNull();

    const passage = await openBranches(D);
    api.branchReplies.push(
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 9 })),
    );
    fireEvent.click(within(passage).getByRole('button', { name: 'Start a branch here' }));
    expect(textOf(await within(passage).findByRole('alert'))).toBe(BRANCH_COPY.studyConflict);
  });

  it('resends an unknown outcome verbatim with the same key on Retry', async () => {
    await openPage();
    const group = await openBranches(O);
    api.branchReplies.push(
      jsonResponse(503, { code: 'UNAVAILABLE', message: 'x', retryable: true, correlationId: 'x' }),
      branchResponse({ ...BRANCHES[1], memberNodeIds: [D, O], revision: 2 } as Branch),
    );
    fireEvent.click(within(group).getByRole('checkbox', { name: LABEL_B }));
    const alert = await within(group).findByRole('alert');
    expect(textOf(alert)).toContain(BRANCH_COPY.unknown);
    act(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    expect(await within(group).findByText(`Added to ${LABEL_B}.`)).toBeTruthy();
    const [first, second] = branchChanges();
    expect(second).toStrictEqual(first);
  });

  it('hands a lifecycle refusal to the section, which turns read-only', async () => {
    await openPage();
    const group = await openBranches(O);
    api.branchReplies.push(jsonResponse(422, envelope('STUDY_ARCHIVED')));
    fireEvent.click(within(group).getByRole('checkbox', { name: LABEL_B }));
    expect(await screen.findByText(NODES_COPY.locked)).toBeTruthy();
  });

  it('lists the branches as text on a read-only study, with no checkboxes and no start', async () => {
    await openPage({ ...STUDY, lifecycle: 'archived' });
    const group = await openBranches(D);
    expect(within(group).queryByRole('checkbox')).toBeNull();
    expect(within(group).queryByRole('button', { name: 'Start a branch here' })).toBeNull();
    expect(
      within(group)
        .getAllByRole('listitem')
        .map((item) => textOf(item)),
    ).toStrictEqual([`In ${LABEL_A}`, `In ${LABEL_B}`]);
  });
});
