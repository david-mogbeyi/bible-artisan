import type { EdgeType, GraphResponse, NodeSummary, StudyNodeType } from '@bible-artisan/contracts';
import { MarkerType } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  arrange,
  fallbackPositions,
  focusStart,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeData,
  toFlowEdges,
  toFlowNodes,
  visibility,
  visibilityText,
} from './graph-view';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STUDY = id(999);

function node(
  n: number,
  type: StudyNodeType = 'thought',
  extra: Partial<NodeSummary> = {},
): NodeSummary {
  return {
    id: id(n),
    type,
    origin: type === 'scripture' ? 'scripture' : type === 'source' ? 'external' : 'user',
    label: `Node ${n}`,
    status: type === 'question' ? 'open' : null,
    observationKind: null,
    referenceId: null,
    canonicalNodeId: null,
    revision: 1,
    createdAt: `2026-10-02T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...extra,
  };
}

function edge(n: number, source: number, target: number, type: EdgeType = 'supports') {
  return {
    id: id(500 + n),
    sourceNodeId: id(source),
    targetNodeId: id(target),
    type,
    origin: 'user' as const,
  };
}

function graph(partial: Partial<GraphResponse>): GraphResponse {
  return {
    studyId: STUDY,
    contentRevision: 1,
    viewRevision: 1,
    nodes: [],
    edges: [],
    branches: [],
    positions: [],
    ...partial,
  };
}

const NONE = new Set<StudyNodeType>();

describe('toFlowNodes / toFlowEdges', () => {
  const g = graph({
    nodes: [
      node(1, 'question', { label: 'What is conscience?' }),
      node(2, 'scripture', { label: 'Romans 9:1', canonicalNodeId: id(3) }),
      node(3, 'scripture', { label: 'Romans 9:1' }),
    ],
    edges: [edge(1, 2, 1, 'raises_question'), edge(2, 2, 3, 'parallels')],
    branches: [
      {
        id: id(700),
        rootNodeId: id(1),
        memberNodeIds: [],
        revision: 1,
        createdAt: '2026-10-02T10:00:00.000Z',
      },
    ],
  });
  const all = new Set([id(1), id(2), id(3)]);

  it('maps nodes to React Flow objects with text names, root and duplicate data, and no connecting', () => {
    const positions = {
      [id(1)]: { x: 0, y: 0 },
      [id(2)]: { x: 10, y: 20 },
      [id(3)]: { x: 5, y: 5 },
    };
    const nodes = toFlowNodes(g.nodes, nodeData(g), positions, all, new Set([id(2)]), true);
    expect(
      nodes.map((n) => ({
        id: n.id,
        position: n.position,
        selected: n.selected,
        ariaLabel: n.ariaLabel,
        root: n.data.branchRoot,
        duplicate: n.data.summary.canonicalNodeId !== null,
        draggable: n.draggable,
        connectable: n.connectable,
      })),
    ).toStrictEqual([
      {
        id: id(1),
        position: { x: 0, y: 0 },
        selected: false,
        ariaLabel: 'Question: What is conscience?, Open',
        root: true,
        duplicate: false,
        draggable: true,
        connectable: false,
      },
      {
        id: id(2),
        position: { x: 10, y: 20 },
        selected: true,
        ariaLabel: 'Scripture: Romans 9:1 (duplicate)',
        root: false,
        duplicate: true,
        draggable: true,
        connectable: false,
      },
      {
        id: id(3),
        position: { x: 5, y: 5 },
        selected: false,
        ariaLabel: 'Scripture: Romans 9:1',
        root: false,
        duplicate: false,
        draggable: true,
        connectable: false,
      },
    ]);
    expect(toFlowNodes(g.nodes, nodeData(g), positions, all, new Set(), false)[0]?.draggable).toBe(
      false,
    );
  });

  it("keeps unmoved nodes' data and flow objects when a save is acknowledged, rebuilding only the moved node", () => {
    const before = graph({
      ...g,
      positions: [
        { nodeId: id(1), x: 0, y: 0 },
        { nodeId: id(2), x: 10, y: 20 },
        { nodeId: id(3), x: 5, y: 5 },
      ],
    });
    const at = (gr: GraphResponse) =>
      Object.fromEntries(gr.positions.map((p) => [p.nodeId, { x: p.x, y: p.y }]));
    const data = nodeData(before);
    const first = toFlowNodes(before.nodes, data, at(before), all, new Set(), true);
    // The acknowledgement: a new response with the same content, a new view revision and the
    // moved node's saved position.
    const acknowledged: GraphResponse = {
      ...before,
      viewRevision: 2,
      positions: before.positions.map((p) => (p.nodeId === id(2) ? { ...p, x: 40 } : p)),
    };
    const ackData = nodeData(acknowledged);
    for (const n of [1, 2, 3]) expect(ackData.get(id(n))).toBe(data.get(id(n)));
    const second = toFlowNodes(acknowledged.nodes, ackData, at(acknowledged), all, new Set(), true);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.position).toStrictEqual({ x: 40, y: 20 });
    expect(second[1]?.data).toBe(first[1]?.data);
    // A changed summary (a refetch after an edit) gets a new data object; the others keep theirs.
    const edited = {
      ...before,
      nodes: before.nodes.map((s, i) => (i === 0 ? { ...s, label: 'Why?' } : s)),
    };
    const editedData = nodeData(edited);
    expect(editedData.get(id(1))).not.toBe(data.get(id(1)));
    expect(editedData.get(id(3))).toBe(data.get(id(3)));
  });

  it('gives directed edges an arrowhead and two-way edges none, each with its relationship in words', () => {
    expect(
      toFlowEdges(g, all).map((e) => ({
        id: e.id,
        label: e.label,
        ariaLabel: e.ariaLabel,
        markerEnd: e.markerEnd,
      })),
    ).toStrictEqual([
      {
        id: id(501),
        label: 'raises the question',
        ariaLabel:
          'Scripture: Romans 9:1 (duplicate) raises the question Question: What is conscience?',
        markerEnd: { type: MarkerType.ArrowClosed },
      },
      {
        id: id(502),
        label: 'parallels',
        ariaLabel: 'Scripture: Romans 9:1 (duplicate) parallels Scripture: Romans 9:1',
        markerEnd: undefined,
      },
    ]);
  });
});

describe('visibility', () => {
  // 1 question — 2 scripture — 3 thought — 4 thought — 5 thought; 6 source attached to 1.
  const g = graph({
    nodes: [
      node(1, 'question'),
      node(2, 'scripture'),
      node(3),
      node(4),
      node(5),
      node(6, 'source'),
    ],
    edges: [edge(1, 2, 1), edge(2, 3, 2), edge(3, 3, 4), edge(4, 5, 4), edge(5, 6, 1)],
  });

  it('hides filtered types and the edges touching them, and says how many in text', () => {
    const view = visibility(g, { hiddenTypes: new Set(['source', 'scripture']), focus: null });
    expect([...view.visible].sort()).toStrictEqual([id(1), id(3), id(4), id(5)]);
    expect(toFlowEdges(g, view.visible).map((e) => e.id)).toStrictEqual([id(503), id(504)]);
    expect(visibilityText(6, view, false)).toBe('Showing 4 of 6 nodes · 2 hidden by filters');
    expect(visibilityText(6, visibility(g, { hiddenTypes: NONE, focus: null }), false)).toBe(
      'Showing 6 of 6 nodes',
    );
  });

  it('focuses two hops around a node (direction ignored) with the next hop counted, and Expand adds one', () => {
    const two = visibility(g, { hiddenTypes: NONE, focus: { nodeId: id(1), depth: 2 } });
    expect([...two.visible].sort()).toStrictEqual([id(1), id(2), id(3), id(6)]);
    expect({ hiddenByFocus: two.hiddenByFocus, nearby: two.nearby }).toStrictEqual({
      hiddenByFocus: 2,
      nearby: 1,
    });
    expect(visibilityText(6, two, true)).toBe(
      'Showing 4 of 6 nodes · 2 hidden by focus · 1 more nearby',
    );
    const three = visibility(g, { hiddenTypes: NONE, focus: { nodeId: id(1), depth: 3 } });
    expect([...three.visible].sort()).toStrictEqual([id(1), id(2), id(3), id(4), id(6)]);
    expect({ hiddenByFocus: three.hiddenByFocus, nearby: three.nearby }).toStrictEqual({
      hiddenByFocus: 1,
      nearby: 1,
    });
  });

  it('keeps the focused node visible even when its type is filtered', () => {
    const view = visibility(g, {
      hiddenTypes: new Set(['question']),
      focus: { nodeId: id(1), depth: 2 },
    });
    expect(view.visible.has(id(1))).toBe(true);
  });
});

describe('fallbackPositions', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(i + 1));

  it('places unpositioned nodes in rows below the positioned ones, deterministically and without overlap', () => {
    const placed = { [id(1)]: { x: 100, y: 50 }, [id(2)]: { x: 400, y: 300 } };
    const first = fallbackPositions(nodes, placed);
    expect(fallbackPositions([...nodes].reverse(), placed)).toStrictEqual(first);
    expect(Object.keys(first).sort()).toStrictEqual(
      nodes
        .slice(2)
        .map((n) => n.id)
        .sort(),
    );
    const boxes = [...Object.values(placed), ...Object.values(first)];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        if (!a || !b) continue;
        const overlap = Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
        expect(overlap).toBe(false);
      }
    }
    expect(first[id(3)]).toStrictEqual({ x: 100, y: 300 + NODE_HEIGHT + 40 });
  });

  it('keeps a node in its slot for the session when another node moves', () => {
    const first = fallbackPositions(nodes, { [id(1)]: { x: 0, y: 0 } });
    const after = fallbackPositions(nodes, { [id(1)]: { x: 0, y: 9000 } }, first);
    expect(after).toStrictEqual(first);
  });

  it('starts at the origin when nothing is positioned', () => {
    expect(fallbackPositions([node(1)], {})).toStrictEqual({ [id(1)]: { x: 0, y: 0 } });
  });
});

describe('arrange', () => {
  const g = graph({
    nodes: [node(1, 'question'), node(2), node(3), node(4), node(9)],
    edges: [edge(1, 2, 1), edge(2, 3, 2), edge(3, 2, 3, 'qualifies'), edge(4, 4, 9)],
  });
  const current = {
    [id(1)]: { x: 300, y: 120 },
    [id(2)]: { x: 900, y: 40 },
    [id(3)]: { x: 50, y: 700 },
    [id(4)]: { x: 10, y: 10 },
    [id(9)]: { x: 2000, y: 2000 },
  };

  it('is deterministic, covers only the set, keeps its top-left corner, and handles a cycle', () => {
    const ids = [id(3), id(1), id(2)];
    const first = arrange(ids, g, current);
    expect(arrange([...ids].reverse(), g, current)).toStrictEqual(first);
    expect(Object.keys(first).sort()).toStrictEqual([id(1), id(2), id(3)]);
    const xs = Object.values(first).map((p) => p.x);
    const ys = Object.values(first).map((p) => p.y);
    expect({ x: Math.min(...xs), y: Math.min(...ys) }).toStrictEqual({ x: 50, y: 40 });
    // Layered: the question (target of supports) and its supporter are on different ranks.
    expect(first[id(1)]?.y).not.toBe(first[id(2)]?.y);
  });
});

const T0 = '2026-10-02T09:00:00.000Z';
const branch = (n: number, root: number, members: number[], createdAt = T0) => ({
  id: id(800 + n),
  rootNodeId: id(root),
  memberNodeIds: members.map(id),
  revision: 1,
  createdAt,
});

describe('branch view options (BIB-60)', () => {
  // Branch A: root 1, members 3, 4, 5. Branch B: root 2, members 5, 6. Node 7 is in none.
  // Node 2 (B's root) is also a member of A.
  const g = graph({
    nodes: [
      node(1, 'question'),
      node(2, 'question'),
      node(3),
      node(4, 'source'),
      node(5),
      node(6),
      node(7),
    ],
    edges: [edge(1, 3, 1), edge(2, 5, 2), edge(3, 6, 7)],
    branches: [branch(1, 1, [3, 4, 5, 2]), branch(2, 2, [5, 6], '2026-10-02T09:30:00.000Z')],
  });
  const A = id(801);
  const B = id(802);
  const sorted = (set: ReadonlySet<string>) => [...set].sort();

  it('shows only one branch (root and members), intersected with type filters and focus, and counts the rest', () => {
    const solo = visibility(g, { hiddenTypes: NONE, focus: null, soloBranchId: B });
    expect(sorted(solo.visible)).toStrictEqual([id(2), id(5), id(6)]);
    expect(visibilityText(7, solo, false, 'Branch: Question: Node 2')).toBe(
      'Showing 3 of 7 nodes · 4 outside Branch: Question: Node 2',
    );
    const filtered = visibility(g, {
      hiddenTypes: new Set(['source']),
      focus: null,
      soloBranchId: A,
    });
    expect(sorted(filtered.visible)).toStrictEqual([id(1), id(2), id(3), id(5)]);
    expect([filtered.outsideBranch, filtered.hiddenByFilters]).toStrictEqual([2, 1]);
    const focused = visibility(g, {
      hiddenTypes: NONE,
      focus: { nodeId: id(1), depth: 1 },
      soloBranchId: A,
    });
    // One hop from 1 is 3 only (7 is two hops and outside A anyway).
    expect(sorted(focused.visible)).toStrictEqual([id(1), id(3)]);
    // A branch no longer in the snapshot is ignored: everything shows.
    expect(
      visibility(g, { hiddenTypes: NONE, focus: null, soloBranchId: id(899) }).visible.size,
    ).toBe(7);
  });

  it('collapses only exclusive members: a node shared with an open branch and every root stay; a node in two collapsed branches hides; the root counts what it hides', () => {
    const one = visibility(g, { hiddenTypes: NONE, focus: null, collapsedBranchIds: [A] });
    // 5 is shared with open B, 2 roots B: both stay. 3 and 4 hide.
    expect(sorted(one.visible)).toStrictEqual([id(1), id(2), id(5), id(6), id(7)]);
    expect(one.collapsedByRoot).toStrictEqual(new Map([[id(1), 2]]));
    expect(visibilityText(7, one, false)).toBe('Showing 5 of 7 nodes · 2 in collapsed branches');

    const both = visibility(g, { hiddenTypes: NONE, focus: null, collapsedBranchIds: [A, B] });
    // 5 is now in two collapsed branches: hidden, and counted on both roots. Roots 1 and 2 stay.
    expect(sorted(both.visible)).toStrictEqual([id(1), id(2), id(7)]);
    expect(both.collapsedByRoot).toStrictEqual(
      new Map([
        [id(1), 3],
        [id(2), 2],
      ]),
    );
    expect(both.hiddenByCollapse).toBe(4);
    // Edges touching hidden nodes are not drawn.
    expect(toFlowEdges(g, both.visible)).toStrictEqual([]);
    // The "+N hidden" count reaches the canvas node's data and accessible name.
    const data = nodeData(g, both.collapsedByRoot);
    expect(data.get(id(1))?.hiddenCount).toBe(3);
    const positions = Object.fromEntries(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }]));
    const [root] = toFlowNodes(g.nodes, data, positions, both.visible, new Set(), false);
    expect(root?.ariaLabel).toBe('Question: Node 1, Open, 3 hidden');
  });

  it('places an unpositioned member beside its oldest branch root, deterministically and without overlap; other nodes keep the rows rule', () => {
    const placed = {
      [id(1)]: { x: 1000, y: 1000 },
      [id(2)]: { x: -500, y: -500 },
      // A node in the first slot right of root 1, so the member skips it.
      [id(7)]: { x: 1000 + NODE_WIDTH + 40, y: 1000 },
    };
    const first = fallbackPositions(g.nodes, placed, {}, g.branches);
    expect(
      fallbackPositions([...g.nodes].reverse(), placed, {}, [...g.branches].reverse()),
    ).toStrictEqual(first);
    // 3, 4, 5 are members of A (the oldest branch of 5 too); 6 only of B.
    expect(first).toStrictEqual({
      [id(3)]: { x: 1000 + 2 * (NODE_WIDTH + 40), y: 1000 },
      [id(4)]: { x: 1000 + 3 * (NODE_WIDTH + 40), y: 1000 },
      [id(5)]: { x: 1000 + 4 * (NODE_WIDTH + 40), y: 1000 },
      [id(6)]: { x: -500 + (NODE_WIDTH + 40), y: -500 },
    });
    const boxes = [...Object.values(placed), ...Object.values(first)];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        if (!a || !b) continue;
        expect(Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT).toBe(false);
      }
    }
    // A full row beside the root wraps to the next row down.
    const crowded = graph({
      nodes: Array.from({ length: 7 }, (_, i) => node(i + 1)),
      branches: [branch(9, 1, [2, 3, 4, 5, 6, 7])],
    });
    const wrapped = fallbackPositions(
      crowded.nodes,
      { [id(1)]: { x: 0, y: 0 } },
      {},
      crowded.branches,
    );
    expect(wrapped[id(7)]).toStrictEqual({ x: NODE_WIDTH + 40, y: NODE_HEIGHT + 40 });
  });

  it('arranges a branch around its root: the root keeps its position and only branch nodes are returned', () => {
    const current = Object.fromEntries(g.nodes.map((n, i) => [n.id, { x: i * 37, y: 500 - i }]));
    const ids = [id(1), id(3), id(4), id(5), id(2)];
    const proposed = arrange(ids, g, current, id(1));
    expect(Object.keys(proposed).sort()).toStrictEqual([...ids].sort());
    expect(proposed[id(1)]).toStrictEqual(current[id(1)]);
    expect(arrange([...ids].reverse(), g, current, id(1))).toStrictEqual(proposed);
  });
});

describe('focusStart', () => {
  const many = Array.from({ length: 501 }, (_, i) => node(i + 1, i === 9 ? 'question' : 'thought'));

  it('opens a study over 500 nodes on the main question, else the oldest branch root, else the oldest node', () => {
    const branches = [
      {
        id: id(800),
        rootNodeId: id(20),
        memberNodeIds: [],
        revision: 1,
        createdAt: '2026-10-02T10:00:00.000Z',
      },
    ];
    expect(focusStart(graph({ nodes: many, branches }), id(10))).toBe(id(10));
    expect(focusStart(graph({ nodes: many, branches }), null)).toBe(id(20));
    expect(focusStart(graph({ nodes: many }), id(77777))).toBe(id(60));
    expect(focusStart(graph({ nodes: many.slice(0, 500) }), id(10))).toBeNull();
  });
});
