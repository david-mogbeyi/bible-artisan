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
    branches: [{ id: id(700), rootNodeId: id(1), createdAt: '2026-10-02T10:00:00.000Z' }],
  });
  const all = new Set([id(1), id(2), id(3)]);

  it('maps nodes to React Flow objects with text names, root and duplicate data, and no connecting', () => {
    const positions = {
      [id(1)]: { x: 0, y: 0 },
      [id(2)]: { x: 10, y: 20 },
      [id(3)]: { x: 5, y: 5 },
    };
    const nodes = toFlowNodes(g, nodeData(g), positions, all, new Set([id(2)]), true);
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
    expect(toFlowNodes(g, nodeData(g), positions, all, new Set(), false)[0]?.draggable).toBe(false);
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

describe('focusStart', () => {
  const many = Array.from({ length: 501 }, (_, i) => node(i + 1, i === 9 ? 'question' : 'thought'));

  it('opens a study over 500 nodes on the main question, else the oldest branch root, else the oldest node', () => {
    const branches = [{ id: id(800), rootNodeId: id(20), createdAt: '2026-10-02T10:00:00.000Z' }];
    expect(focusStart(graph({ nodes: many, branches }), id(10))).toBe(id(10));
    expect(focusStart(graph({ nodes: many, branches }), null)).toBe(id(20));
    expect(focusStart(graph({ nodes: many }), id(77777))).toBe(id(60));
    expect(focusStart(graph({ nodes: many.slice(0, 500) }), id(10))).toBeNull();
  });
});
