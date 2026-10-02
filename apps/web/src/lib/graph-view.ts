import { Graph, layout } from '@dagrejs/dagre';
import {
  type Branch,
  EDGE_PHRASES,
  FOCUSED_VIEW_NODE_THRESHOLD,
  type GraphEdge,
  type GraphResponse,
  isSymmetricEdgeType,
  type NodeSummary,
  type StudyNodeType,
} from '@bible-artisan/contracts';
import { type Edge, MarkerType, type Node } from '@xyflow/react';
import { branchNodeIds } from './branches';
import { nodeOptionText, nodeStateText } from './nodes';

/**
 * The canvas view model (BIB-28): pure functions from the library-independent graph snapshot to
 * React Flow view objects and back. Domain DTOs in, React Flow objects out; the only thing that
 * ever returns to the API is `{ nodeId, x, y }`. Nothing here changes stored data: filters, focus,
 * branch collapse and show-only (BIB-60), and arrangement previews are presentation (FR-GRAPH-008).
 */

/** The canvas node component's fixed size, used for fallback slots and the layered layout. */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 96;
const GAP = 40;
const FALLBACK_COLUMNS = 5;

/** Below this width the canvas is read-only (PRD section 11: no drag editing on phones). */
export const MIN_EDIT_WIDTH = 900;

/** Arrange works on one atomic save's worth of nodes (PRD section 24 batch maximum). */
export const MAX_ARRANGE_NODES = 100;

export interface XY {
  x: number;
  y: number;
}

export type Positions = Readonly<Record<string, XY>>;

/**
 * The snapshot's content, without its layout: what everything derived here is keyed on, so a
 * position save (a new `positions` and `viewRevision`) rebuilds nothing but moved nodes.
 */
export type GraphContent = Pick<GraphResponse, 'nodes' | 'edges' | 'branches'>;

/**
 * What a canvas node renders: the summary, whether it roots a branch, and how many members its
 * collapsed branch hides (0 when not collapsed). Built once per snapshot and view.
 */
export interface GraphNodeData extends Record<string, unknown> {
  summary: NodeSummary;
  branchRoot: boolean;
  hiddenCount: number;
}

export type GraphFlowNode = Node<GraphNodeData, 'study'>;

/** Oldest first, ties by id: the order every deterministic rule here uses. */
function byAge(a: NodeSummary, b: NodeSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Oldest first, ties by id, for branches. */
function byBranchAge(a: Pick<Branch, 'id' | 'createdAt'>, b: Pick<Branch, 'id' | 'createdAt'>) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function storedPositions(positions: GraphResponse['positions']): Record<string, XY> {
  return Object.fromEntries(positions.map((p) => [p.nodeId, { x: p.x, y: p.y }]));
}

/** One fallback slot's footprint: a node plus the gap around it. */
const SLOT_WIDTH = NODE_WIDTH + GAP;
const SLOT_HEIGHT = NODE_HEIGHT + GAP;

/**
 * The positions already taken, bucketed by slot-sized cells, so checking a candidate slot looks
 * at its neighboring cells only (no scan of every node).
 */
class Occupancy {
  private readonly cells = new Map<string, XY[]>();

  constructor(taken: Iterable<XY>) {
    for (const position of taken) this.add(position);
  }

  add(position: XY): void {
    const key = `${Math.floor(position.x / SLOT_WIDTH)}:${Math.floor(position.y / SLOT_HEIGHT)}`;
    const cell = this.cells.get(key);
    if (cell) cell.push(position);
    else this.cells.set(key, [position]);
  }

  /** True when a node at `position` would overlap (or crowd within the gap) a taken one. */
  collides(position: XY): boolean {
    const cx = Math.floor(position.x / SLOT_WIDTH);
    const cy = Math.floor(position.y / SLOT_HEIGHT);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of this.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (
            Math.abs(other.x - position.x) < SLOT_WIDTH &&
            Math.abs(other.y - position.y) < SLOT_HEIGHT
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

/** Rows of five below everything placed: BIB-28's rule for nodes with nowhere better to go. */
function placeInRows(
  nodes: readonly NodeSummary[],
  taken: readonly XY[],
  result: Record<string, XY>,
): void {
  if (nodes.length === 0) return;
  const left = taken.length > 0 ? Math.min(...taken.map((p) => p.x)) : 0;
  const top = taken.length > 0 ? Math.max(...taken.map((p) => p.y)) + NODE_HEIGHT + GAP : 0;
  nodes.forEach((node, index) => {
    result[node.id] = {
      x: left + (index % FALLBACK_COLUMNS) * SLOT_WIDTH,
      y: top + Math.floor(index / FALLBACK_COLUMNS) * SLOT_HEIGHT,
    };
  });
}

/** The first free slot to the right of `root`, row by row downward (five slots per row). */
function besideRoot(root: XY, occupancy: Occupancy, limit: number): XY | null {
  for (let row = 0; row <= limit; row += 1) {
    for (let column = 1; column <= FALLBACK_COLUMNS; column += 1) {
      const slot = { x: root.x + column * SLOT_WIDTH, y: root.y + row * SLOT_HEIGHT };
      if (!occupancy.collides(slot)) return slot;
    }
  }
  return null;
}

/**
 * Slots for nodes with no stored or local position, never saved until moved. `previous` keeps a
 * node's slot for the page session, so placing one node never makes another jump. A new node that
 * is a member of a branch (BIB-60) goes beside its oldest such branch's root (oldest by creation,
 * then id), in the first free slot to the root's right, row by row; every other new node, in age
 * order, fills rows of five below everything already placed. A slot never overlaps a node. The
 * same snapshot (and the same `previous`) always gives the same slots.
 */
export function fallbackPositions(
  nodes: readonly NodeSummary[],
  placed: Positions,
  previous: Positions = {},
  branches: readonly Pick<Branch, 'id' | 'rootNodeId' | 'memberNodeIds' | 'createdAt'>[] = [],
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

  /** Member node id → the root of the oldest branch it is a member of. */
  const rootOf = new Map<string, string>();
  for (const branch of [...branches].sort(byBranchAge)) {
    for (const id of branch.memberNodeIds) {
      if (!rootOf.has(id) && id !== branch.rootNodeId) rootOf.set(id, branch.rootNodeId);
    }
  }
  const members = unplaced.filter((node) => rootOf.has(node.id));
  const others = unplaced.filter((node) => !rootOf.has(node.id));
  const taken = () => [...Object.values(placed), ...Object.values(result)];

  placeInRows(others, taken(), result);
  const occupancy = new Occupancy(taken());
  const limit = Object.keys(placed).length + nodes.length;
  const homeless: NodeSummary[] = [];
  for (const node of members) {
    const rootId = rootOf.get(node.id) as string;
    const root = placed[rootId] ?? result[rootId];
    const slot = root ? besideRoot(root, occupancy, limit) : null;
    if (!slot) {
      homeless.push(node);
      continue;
    }
    result[node.id] = slot;
    occupancy.add(slot);
  }
  placeInRows(homeless, taken(), result);
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
  /** Show only this branch's nodes (BIB-60). An id no longer in the snapshot is ignored. */
  soloBranchId?: string | null;
  /** Collapsed branches (BIB-60). Ids no longer in the snapshot are ignored. */
  collapsedBranchIds?: readonly string[];
}

export interface Visibility {
  visible: ReadonlySet<string>;
  /** Show only: nodes outside the shown branch. */
  outsideBranch: number;
  /** Nodes hidden by the type filters (including Sources), among those show-only leaves. */
  hiddenByFilters: number;
  /** Nodes the filters would show but branch collapse hides. */
  hiddenByCollapse: number;
  /** Nodes the filters and collapse would show but focus hides. */
  hiddenByFocus: number;
  /** In focus: nodes exactly one hop beyond the shown set that Expand would add. */
  nearby: number;
  /** Per collapsed branch's root node: how many of the branch's members collapse hides. */
  collapsedByRoot: ReadonlyMap<string, number>;
}

/**
 * What collapsing `collapsedBranchIds` hides (PRD section 12: "branch collapse hides members
 * exclusive to that branch and shows counts; shared nodes stay visible"): every member of a
 * collapsed branch that belongs to no branch left open, where a node's own rooted branch counts as
 * a branch it belongs to. Roots always stay. Counted per collapsed branch's root.
 */
function collapse(
  branches: GraphContent['branches'],
  collapsedBranchIds: readonly string[],
): { hidden: ReadonlySet<string>; byRoot: ReadonlyMap<string, number> } {
  const collapsed = new Set(collapsedBranchIds);
  const hidden = new Set<string>();
  const byRoot = new Map<string, number>();
  if (!branches.some((branch) => collapsed.has(branch.id))) return { hidden, byRoot };
  const roots = new Set(branches.map((branch) => branch.rootNodeId));
  const open = new Set(
    branches.filter((branch) => !collapsed.has(branch.id)).flatMap(branchNodeIds),
  );
  for (const branch of branches) {
    if (!collapsed.has(branch.id)) continue;
    const exclusive = branch.memberNodeIds.filter((id) => !roots.has(id) && !open.has(id));
    for (const id of exclusive) hidden.add(id);
    byRoot.set(branch.rootNodeId, exclusive.length);
  }
  return { hidden, byRoot };
}

/**
 * Which nodes the canvas (and List View) shows (FR-GRAPH-008: presentation only). Show-only keeps
 * one branch's root and members; type filters hide whole types; collapse hides collapsed branches'
 * exclusive members; focus keeps the focused node and every node within `depth` hops (direction
 * ignored). They compose as an intersection, except that the focused node stays visible even if
 * its type is filtered. An edge is drawn only when both of its nodes are visible (`toFlowEdges`).
 */
export function visibility(graph: GraphContent, options: ViewOptions): Visibility {
  const solo = options.soloBranchId
    ? graph.branches.find((branch) => branch.id === options.soloBranchId)
    : undefined;
  const soloIds = solo ? new Set(branchNodeIds(solo)) : null;
  const inBranch = soloIds ? graph.nodes.filter((node) => soloIds.has(node.id)) : graph.nodes;
  const byType = inBranch.filter((node) => !options.hiddenTypes.has(node.type));
  const collapsed = collapse(graph.branches, options.collapsedBranchIds ?? []);
  const kept = byType.filter((node) => !collapsed.hidden.has(node.id));
  const counts = {
    outsideBranch: graph.nodes.length - inBranch.length,
    hiddenByFilters: inBranch.length - byType.length,
    hiddenByCollapse: byType.length - kept.length,
    collapsedByRoot: collapsed.byRoot,
  };
  const focusNode = options.focus
    ? graph.nodes.find((node) => node.id === options.focus?.nodeId)
    : undefined;
  if (!options.focus || !focusNode) {
    return {
      visible: new Set(kept.map((node) => node.id)),
      ...counts,
      hiddenByFocus: 0,
      nearby: 0,
    };
  }
  const depth = options.focus.depth;
  const hops = distances(focusNode.id, graph.edges, depth + 1);
  const shown = new Set(
    kept.filter((node) => (hops.get(node.id) ?? Infinity) <= depth).map((node) => node.id),
  );
  shown.add(focusNode.id);
  const nearby = kept.filter((node) => hops.get(node.id) === depth + 1).length;
  const filteredShown = kept.filter((node) => shown.has(node.id)).length;
  return {
    visible: shown,
    ...counts,
    hiddenByFocus: kept.length - filteredShown,
    nearby,
  };
}

/**
 * "Showing 40 of 52 nodes · 5 outside Branch: … · 8 hidden by filters · 3 in collapsed branches ·
 * 4 hidden by focus · 9 more nearby". `soloLabel` names the branch shown alone, if any.
 */
export function visibilityText(
  total: number,
  view: Visibility,
  focused: boolean,
  soloLabel: string | null = null,
): string {
  const count = (n: number) => n.toLocaleString('en-US');
  const parts = [`Showing ${count(view.visible.size)} of ${count(total)} nodes`];
  if (soloLabel) parts.push(`${count(view.outsideBranch)} outside ${soloLabel}`);
  if (view.hiddenByFilters > 0) parts.push(`${count(view.hiddenByFilters)} hidden by filters`);
  if (view.hiddenByCollapse > 0) {
    parts.push(`${count(view.hiddenByCollapse)} in collapsed branches`);
  }
  if (focused) {
    parts.push(`${count(view.hiddenByFocus)} hidden by focus`);
    parts.push(`${count(view.nearby)} more nearby`);
  }
  return parts.join(' · ');
}

/** The last data object built for a summary (query results keep unchanged summaries' identity). */
const dataBySummary = new WeakMap<NodeSummary, GraphNodeData>();

/**
 * The data objects canvas nodes render. A node whose summary, branch-root flag and hidden count
 * (`Visibility.collapsedByRoot`) are unchanged keeps its data object, so its memoized canvas node
 * does not re-render.
 */
export function nodeData(
  graph: Omit<GraphContent, 'edges'>,
  hiddenByRoot: ReadonlyMap<string, number> = new Map(),
): Map<string, GraphNodeData> {
  const roots = new Set(graph.branches.map((branch) => branch.rootNodeId));
  return new Map(
    graph.nodes.map((summary) => {
      const branchRoot = roots.has(summary.id);
      const hiddenCount = hiddenByRoot.get(summary.id) ?? 0;
      const kept = dataBySummary.get(summary);
      if (kept?.branchRoot === branchRoot && kept.hiddenCount === hiddenCount) {
        return [summary.id, kept];
      }
      const data = { summary, branchRoot, hiddenCount };
      dataBySummary.set(summary, data);
      return [summary.id, data];
    }),
  );
}

/** A node's accessible name: "Question: What is conscience?, Open". */
export function nodeAccessibleName(summary: NodeSummary): string {
  const state = nodeStateText(summary);
  return `${nodeOptionText(summary, 200)}${state ? `, ${state}` : ''}`;
}

/** The last flow node built for a data object, reused while nothing it shows has changed. */
const flowNodeByData = new WeakMap<GraphNodeData, GraphFlowNode>();

/**
 * React Flow nodes for the visible nodes. A node whose data, position, selection, movability and
 * connectability are unchanged is the same object as last time, so React Flow and the memoized
 * node component skip it: moving or saving one node touches only that node.
 */
export function toFlowNodes(
  nodes: readonly NodeSummary[],
  data: ReadonlyMap<string, GraphNodeData>,
  positions: Positions,
  visible: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  movable: boolean,
  /** Its handles start a drag-to-connect (BIB-29): editable and wide only. */
  connectable = false,
): GraphFlowNode[] {
  const result: GraphFlowNode[] = [];
  for (const summary of nodes) {
    const nodeDataItem = data.get(summary.id);
    const position = positions[summary.id];
    if (!visible.has(summary.id) || !nodeDataItem || !position) continue;
    const isSelected = selected.has(summary.id);
    const kept = flowNodeByData.get(nodeDataItem);
    if (
      kept &&
      kept.position.x === position.x &&
      kept.position.y === position.y &&
      kept.selected === isSelected &&
      kept.draggable === movable &&
      kept.connectable === connectable
    ) {
      result.push(kept);
      continue;
    }
    const node: GraphFlowNode = {
      id: summary.id,
      type: 'study',
      position,
      data: nodeDataItem,
      selected: isSelected,
      draggable: movable,
      connectable,
      deletable: false,
      // A collapsed branch's root says what it hides, in words (never color or position alone).
      ariaLabel: `${nodeAccessibleName(summary)}${
        nodeDataItem.hiddenCount > 0
          ? `, ${nodeDataItem.hiddenCount.toLocaleString('en-US')} hidden`
          : ''
      }`,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
    flowNodeByData.set(nodeDataItem, node);
    result.push(node);
  }
  return result;
}

/**
 * Whether a handle drop may open the Connect dialog (BIB-29): never from a node onto itself
 * (FR-GRAPH-005; the server refuses self-relationships too).
 */
export function isValidConnection(connection: { source: string; target: string }): boolean {
  return connection.source !== connection.target;
}

/**
 * Edges between visible nodes. Directed types get an arrowhead toward the target; two-way types
 * none. Each carries its relationship in words (label and accessible name), never color alone.
 */
export function toFlowEdges(
  graph: Omit<GraphContent, 'branches'>,
  visible: ReadonlySet<string>,
): Edge[] {
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
 * The result is translated so the set's top-left corner stays where it is, or, with `anchorId`
 * (a branch's root, BIB-60), so that node keeps its current position. It covers exactly `ids`, so
 * nothing outside the set moves.
 */
export function arrange(
  ids: readonly string[],
  graph: Omit<GraphContent, 'branches'>,
  current: Positions,
  anchorId: string | null = null,
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
  const fixed = anchorId ? current[anchorId] : undefined;
  const fixedLaid = anchorId ? laid.find((p) => p.id === anchorId) : undefined;
  if (fixed && fixedLaid) {
    const [fx, fy] = [fixed.x - fixedLaid.x, fixed.y - fixedLaid.y];
    return Object.fromEntries(laid.map((p) => [p.id, { x: p.x + fx, y: p.y + fy }]));
  }
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
export function focusStart(
  graph: Omit<GraphContent, 'edges'>,
  mainQuestionNodeId: string | null,
): string | null {
  if (graph.nodes.length <= FOCUSED_VIEW_NODE_THRESHOLD) return null;
  const live = new Set(graph.nodes.map((node) => node.id));
  if (mainQuestionNodeId && live.has(mainQuestionNodeId)) return mainQuestionNodeId;
  const root = graph.branches.find((branch) => live.has(branch.rootNodeId));
  if (root) return root.rootNodeId;
  return [...graph.nodes].sort(byAge)[0]?.id ?? null;
}
