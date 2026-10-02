import { Graph, layout } from '@dagrejs/dagre';
import {
  EDGE_PHRASES,
  FOCUSED_VIEW_NODE_THRESHOLD,
  type GraphEdge,
  type GraphResponse,
  isSymmetricEdgeType,
  type NodeSummary,
  type StudyNodeType,
} from '@bible-artisan/contracts';
import { type Edge, MarkerType, type Node } from '@xyflow/react';
import { nodeOptionText, nodeStateText } from './nodes';

/**
 * The canvas view model (BIB-28): pure functions from the library-independent graph snapshot to
 * React Flow view objects and back. Domain DTOs in, React Flow objects out; the only thing that
 * ever returns to the API is `{ nodeId, x, y }`. Nothing here changes stored data: filters, focus
 * and arrangement previews are presentation (FR-GRAPH-008).
 */

/** The canvas node component's fixed size, used for fallback slots and the layered layout. */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 96;
const GAP = 40;
const FALLBACK_COLUMNS = 5;

/** Arrange works on one atomic save's worth of nodes (PRD section 24 batch maximum). */
export const MAX_ARRANGE_NODES = 100;

export interface XY {
  x: number;
  y: number;
}

export type Positions = Readonly<Record<string, XY>>;

/** What a canvas node renders: the summary, and whether it roots a branch. Built once per snapshot. */
export interface GraphNodeData extends Record<string, unknown> {
  summary: NodeSummary;
  branchRoot: boolean;
}

export type GraphFlowNode = Node<GraphNodeData, 'study'>;

/** Oldest first, ties by id: the order every deterministic rule here uses. */
function byAge(a: NodeSummary, b: NodeSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function storedPositions(graph: GraphResponse): Record<string, XY> {
  return Object.fromEntries(graph.positions.map((p) => [p.nodeId, { x: p.x, y: p.y }]));
}

/**
 * Slots for nodes with no stored or local position, never saved until moved. `previous` keeps a
 * node's slot for the page session, so placing one node never makes another jump. New nodes, in
 * age order, fill rows of five below everything already placed, so a slot never overlaps a node.
 * The same snapshot (and the same `previous`) always gives the same slots.
 */
export function fallbackPositions(
  nodes: readonly NodeSummary[],
  placed: Positions,
  previous: Positions = {},
): Record<string, XY> {
  const result: Record<string, XY> = {};
  const unplaced: NodeSummary[] = [];
  for (const node of [...nodes].sort(byAge)) {
    if (placed[node.id]) continue;
    const kept = previous[node.id];
    if (kept) result[node.id] = kept;
    else unplaced.push(node);
  }
  if (unplaced.length === 0) return result;
  const taken = [...Object.values(placed), ...Object.values(result)];
  const left = taken.length > 0 ? Math.min(...taken.map((p) => p.x)) : 0;
  const top = taken.length > 0 ? Math.max(...taken.map((p) => p.y)) + NODE_HEIGHT + GAP : 0;
  unplaced.forEach((node, index) => {
    result[node.id] = {
      x: left + (index % FALLBACK_COLUMNS) * (NODE_WIDTH + GAP),
      y: top + Math.floor(index / FALLBACK_COLUMNS) * (NODE_HEIGHT + GAP),
    };
  });
  return result;
}

/** Undirected adjacency over live edges (focus ignores direction). */
function adjacency(edges: readonly GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = map.get(a);
    if (list) list.push(b);
    else map.set(a, [b]);
  };
  for (const edge of edges) {
    link(edge.sourceNodeId, edge.targetNodeId);
    link(edge.targetNodeId, edge.sourceNodeId);
  }
  return map;
}

/** Hop distance from `start` over live edges, up to `maxDepth`. */
function distances(
  start: string,
  edges: readonly GraphEdge[],
  maxDepth: number,
): Map<string, number> {
  const next = adjacency(edges);
  const seen = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const following: string[] = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.set(other, depth);
        following.push(other);
      }
    }
    frontier = following;
  }
  return seen;
}

export interface FocusOption {
  nodeId: string;
  /** Hops shown around the node: 2 by default, +1 per Expand. */
  depth: number;
}

export const FOCUS_DEPTH = 2;

export interface ViewOptions {
  hiddenTypes: ReadonlySet<StudyNodeType>;
  focus: FocusOption | null;
}

export interface Visibility {
  visible: ReadonlySet<string>;
  /** Nodes hidden by the type filters (including Sources). */
  hiddenByFilters: number;
  /** Nodes the filters would show but focus hides. */
  hiddenByFocus: number;
  /** In focus: nodes exactly one hop beyond the shown set that Expand would add. */
  nearby: number;
}

/**
 * Which nodes the canvas shows (FR-GRAPH-008: presentation only). Type filters hide whole types;
 * focus keeps the focused node and every node within `depth` hops (direction ignored), and the
 * focused node stays visible even if its type is filtered. An edge is drawn only when both of its
 * nodes are visible (`toFlowEdges`).
 */
export function visibility(graph: GraphResponse, options: ViewOptions): Visibility {
  const byType = graph.nodes.filter((node) => !options.hiddenTypes.has(node.type));
  const hiddenByFilters = graph.nodes.length - byType.length;
  const focusNode = options.focus
    ? graph.nodes.find((node) => node.id === options.focus?.nodeId)
    : undefined;
  if (!options.focus || !focusNode) {
    return {
      visible: new Set(byType.map((node) => node.id)),
      hiddenByFilters,
      hiddenByFocus: 0,
      nearby: 0,
    };
  }
  const depth = options.focus.depth;
  const hops = distances(focusNode.id, graph.edges, depth + 1);
  const shown = new Set(
    byType.filter((node) => (hops.get(node.id) ?? Infinity) <= depth).map((node) => node.id),
  );
  shown.add(focusNode.id);
  const nearby = byType.filter((node) => hops.get(node.id) === depth + 1).length;
  const filteredShown = byType.filter((node) => shown.has(node.id)).length;
  return {
    visible: shown,
    hiddenByFilters,
    hiddenByFocus: byType.length - filteredShown,
    nearby,
  };
}

/** "Showing 40 of 52 nodes · 8 hidden by filters · 4 hidden by focus · 9 more nearby". */
export function visibilityText(total: number, view: Visibility, focused: boolean): string {
  const count = (n: number) => n.toLocaleString('en-US');
  const parts = [`Showing ${count(view.visible.size)} of ${count(total)} nodes`];
  if (view.hiddenByFilters > 0) parts.push(`${count(view.hiddenByFilters)} hidden by filters`);
  if (focused) {
    parts.push(`${count(view.hiddenByFocus)} hidden by focus`);
    parts.push(`${count(view.nearby)} more nearby`);
  }
  return parts.join(' · ');
}

/** The data objects canvas nodes render, built once per snapshot so memoized nodes stay put. */
export function nodeData(graph: GraphResponse): Map<string, GraphNodeData> {
  const roots = new Set(graph.branches.map((branch) => branch.rootNodeId));
  return new Map(
    graph.nodes.map((summary) => [summary.id, { summary, branchRoot: roots.has(summary.id) }]),
  );
}

/** A node's accessible name: "Question: What is conscience?, Open". */
export function nodeAccessibleName(summary: NodeSummary): string {
  const state = nodeStateText(summary);
  return `${nodeOptionText(summary, 200)}${state ? `, ${state}` : ''}`;
}

export function toFlowNodes(
  graph: GraphResponse,
  data: ReadonlyMap<string, GraphNodeData>,
  positions: Positions,
  visible: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  movable: boolean,
): GraphFlowNode[] {
  const result: GraphFlowNode[] = [];
  for (const summary of graph.nodes) {
    const nodeDataItem = data.get(summary.id);
    const position = positions[summary.id];
    if (!visible.has(summary.id) || !nodeDataItem || !position) continue;
    result.push({
      id: summary.id,
      type: 'study',
      position,
      data: nodeDataItem,
      selected: selected.has(summary.id),
      draggable: movable,
      connectable: false,
      deletable: false,
      ariaLabel: nodeAccessibleName(summary),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }
  return result;
}

/**
 * Edges between visible nodes. Directed types get an arrowhead toward the target; two-way types
 * none. Each carries its relationship in words (label and accessible name), never color alone.
 */
export function toFlowEdges(graph: GraphResponse, visible: ReadonlySet<string>): Edge[] {
  const names = new Map(graph.nodes.map((node) => [node.id, nodeOptionText(node)]));
  return graph.edges
    .filter((edge) => visible.has(edge.sourceNodeId) && visible.has(edge.targetNodeId))
    .map((edge) => {
      const phrase = EDGE_PHRASES[edge.type].outgoing;
      return {
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        label: phrase,
        ariaLabel: `${names.get(edge.sourceNodeId) ?? ''} ${phrase} ${names.get(edge.targetNodeId) ?? ''}`,
        deletable: false,
        ...(isSymmetricEdgeType(edge.type) ? {} : { markerEnd: { type: MarkerType.ArrowClosed } }),
      };
    });
}

/**
 * A deterministic layered layout (PRD section 12) of `ids` with dagre: top to bottom, cycles
 * handled by the greedy acyclicer (cycles are valid in a study graph). Input order is fixed (nodes
 * by age, edges among the set by id), so the same snapshot always proposes the same positions.
 * The result is translated so the set's top-left corner stays where it is; it covers exactly
 * `ids`, so nothing outside the set moves.
 */
export function arrange(
  ids: readonly string[],
  graph: GraphResponse,
  current: Positions,
): Record<string, XY> {
  const set = new Set(ids);
  const nodes = graph.nodes.filter((node) => set.has(node.id)).sort(byAge);
  if (nodes.length === 0) return {};
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', acyclicer: 'greedy', nodesep: GAP, ranksep: GAP * 1.5 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  const edges = graph.edges
    .filter((edge) => set.has(edge.sourceNodeId) && set.has(edge.targetNodeId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of edges) g.setEdge(edge.sourceNodeId, edge.targetNodeId, {}, edge.id);
  layout(g);

  const laid = nodes.map((node) => {
    const placed = g.node(node.id) as { x: number; y: number };
    return { id: node.id, x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 };
  });
  const before = nodes.map((node) => current[node.id]).filter((p): p is XY => p !== undefined);
  const anchor = {
    x: before.length > 0 ? Math.min(...before.map((p) => p.x)) : 0,
    y: before.length > 0 ? Math.min(...before.map((p) => p.y)) : 0,
  };
  const dx = anchor.x - Math.min(...laid.map((p) => p.x));
  const dy = anchor.y - Math.min(...laid.map((p) => p.y));
  return Object.fromEntries(laid.map((p) => [p.id, { x: p.x + dx, y: p.y + dy }]));
}

/**
 * Where a study with more than `FOCUSED_VIEW_NODE_THRESHOLD` live nodes opens (PRD section 12):
 * focused on its main question node, else its oldest branch's root, else its oldest node. Null
 * for a smaller study, which opens in full.
 */
export function focusStart(graph: GraphResponse, mainQuestionNodeId: string | null): string | null {
  if (graph.nodes.length <= FOCUSED_VIEW_NODE_THRESHOLD) return null;
  const live = new Set(graph.nodes.map((node) => node.id));
  if (mainQuestionNodeId && live.has(mainQuestionNodeId)) return mainQuestionNodeId;
  const root = graph.branches.find((branch) => live.has(branch.rootNodeId));
  if (root) return root.rootNodeId;
  return [...graph.nodes].sort(byAge)[0]?.id ?? null;
}
