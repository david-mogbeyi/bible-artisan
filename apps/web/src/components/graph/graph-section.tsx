'use client';

import '@xyflow/react/dist/style.css';
import {
  type GraphResponse,
  NODE_TYPE_NAMES,
  STUDY_NODE_TYPES,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
} from '@xyflow/react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { fetchGraph, graphQueryKey } from '@/lib/graph';
import { useGraphView, useGraphViewStore } from '@/lib/graph-store';
import {
  arrange,
  fallbackPositions,
  FOCUS_DEPTH,
  focusStart,
  MAX_ARRANGE_NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeData,
  type Positions,
  storedPositions,
  toFlowEdges,
  toFlowNodes,
  visibility,
  visibilityText,
  type XY,
} from '@/lib/graph-view';
import { NODE_TYPES } from './graph-node';
import { type LayoutSaveStatus, usePositionSaver } from './use-position-saver';

export const GRAPH_COPY = {
  loading: 'Loading the graph…',
  empty: 'No nodes yet. Add a passage or question in Nodes below.',
  readOnly: "Read-only study: the layout can't be changed.",
  narrow: 'Moving nodes needs a wider screen. Everything is in the Nodes list below.',
  instructions:
    'Tab moves between nodes. Enter opens a node. Arrow keys move the selected node. Escape clears the selection. Shift+click adds to the selection. Everything here is also in the Nodes list below.',
  /** Read-only (archived, trashed or narrow): nothing about moving; the reason is described too. */
  readOnlyInstructions:
    'Tab moves between nodes. Enter opens a node. Escape clears the selection. Shift+click adds to the selection. Nodes cannot be moved here. Everything here is also in the Nodes list below.',
  refreshFailed: "Couldn't refresh the graph. It may be out of date.",
  arrangeLimit: `Arrange works on up to ${MAX_ARRANGE_NODES} nodes.`,
  applied: 'Arrangement applied.',
  undone: 'Arrangement undone.',
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "Couldn't load the graph. The Nodes list below still has everything.",
  refused: "Couldn't load the graph. The Nodes list below still has everything.",
  unavailable: "Couldn't load the graph. The Nodes list below still has everything.",
};

/** Below this width the canvas is read-only (PRD section 11: no drag editing on phones). */
export const MIN_EDIT_WIDTH = 900;

function subscribeResize(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function useWideViewport(): boolean {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth >= MIN_EDIT_WIDTH,
    () => true,
  );
}

/**
 * The study's graph canvas (BIB-28): every live node and relationship from one `GET /graph`
 * snapshot, drawn with React Flow. Pan, zoom 25-200 %, fit, minimap and selection always work;
 * moving nodes (drag or arrow keys) saves positions against the layout's own view revision, never
 * the study's, so it cannot conflict with content edits. Filters and focus are presentation only.
 * The Nodes list below stays the complete non-canvas path; selection is shared with it.
 */
export function GraphSection({ study }: { study: StudyResponse }) {
  const headingId = useId();
  const graph = useQuery({
    queryKey: graphQueryKey(study.id),
    queryFn: () => fetchGraph(study.id),
  });
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-serif text-2xl">
        Graph
      </h2>
      {graph.data ? (
        <>
          {/* A failed background refetch: the canvas stays, with a non-blocking alert. */}
          {graph.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <p>{GRAPH_COPY.refreshFailed}</p>
              <button type="button" onClick={() => void graph.refetch()} className="underline">
                Retry
              </button>
            </div>
          ) : null}
          {graph.data.nodes.length === 0 ? (
            <p className="text-muted">{GRAPH_COPY.empty}</p>
          ) : (
            <ReactFlowProvider>
              <GraphCanvas study={study} graph={graph.data} />
            </ReactFlowProvider>
          )}
        </>
      ) : graph.isError ? (
        <ProblemAlert error={graph.error} copy={LOAD_COPY} onRetry={() => void graph.refetch()} />
      ) : (
        <div
          role="status"
          className="flex h-[min(70vh,720px)] min-h-[420px] items-center justify-center rounded border border-muted text-muted"
        >
          {GRAPH_COPY.loading}
        </div>
      )}
    </section>
  );
}

interface Arrangement {
  ids: string[];
  proposed: Record<string, XY>;
  previous: Record<string, XY>;
}

function GraphCanvas({ study, graph }: { study: StudyResponse; graph: GraphResponse }) {
  const store = useGraphViewStore();
  const flow = useReactFlow();
  const instructionsId = useId();
  const readOnlyId = useId();
  const selectedNodeIds = useGraphView((s) => s.selectedNodeIds);
  const selectionSource = useGraphView((s) => s.selectionSource);
  const hiddenTypes = useGraphView((s) => s.hiddenTypes);
  const focus = useGraphView((s) => s.focus);
  const localPositions = useGraphView((s) => s.localPositions);
  const wide = useWideViewport();
  /** The study revision a lifecycle refusal arrived at: read-only until the study reloads. */
  const [lockedAt, setLockedAt] = useState<number | null>(null);
  const lock = useCallback(() => setLockedAt(study.revision), [study.revision]);
  const editable = study.lifecycle === 'active' && lockedAt !== study.revision;
  const movable = editable && wide;
  const saver = usePositionSaver(study.id, lock);
  const { save } = saver;

  // Everything derived is keyed on the snapshot's content, not the whole response: a position
  // save (new positions and view revision) rebuilds nothing but the moved nodes (graph-view.ts).
  const content = useMemo(
    () => ({ nodes: graph.nodes, edges: graph.edges, branches: graph.branches }),
    [graph.branches, graph.edges, graph.nodes],
  );

  // A study over the threshold opens focused (PRD section 12); "Show all" leaves it.
  const [largeStart] = useState(() => focusStart(content, study.mainQuestion?.nodeId ?? null));
  const [largeNotice, setLargeNotice] = useState(largeStart !== null);
  useEffect(() => {
    if (largeStart) store.getState().setFocus({ nodeId: largeStart, depth: FOCUS_DEPTH });
  }, [largeStart, store]);

  // Fallback slots for unpositioned nodes, kept for the page session (a slot never jumps).
  const stored = useMemo(() => storedPositions(graph.positions), [graph.positions]);
  const [fallback, setFallback] = useState(() => fallbackPositions(graph.nodes, stored));
  const [placedFor, setPlacedFor] = useState(graph.nodes);
  if (placedFor !== graph.nodes) {
    setPlacedFor(graph.nodes);
    setFallback((previous) =>
      fallbackPositions(graph.nodes, { ...stored, ...localPositions }, previous),
    );
  }

  const [preview, setPreview] = useState<Arrangement | null>(null);
  const [lastArrangement, setLastArrangement] = useState<Arrangement | null>(null);
  const [arrangeMessage, setArrangeMessage] = useState('');
  /** Positions while a node is being dragged (cleared when the drag ends). */
  const [dragging, setDragging] = useState<Positions>({});
  const arrangeButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);

  const positions: Positions = useMemo(
    () => ({
      ...fallback,
      ...stored,
      ...localPositions,
      ...preview?.proposed,
      ...dragging,
    }),
    [dragging, fallback, localPositions, preview, stored],
  );
  const view = useMemo(
    () => visibility(content, { hiddenTypes, focus }),
    [content, focus, hiddenTypes],
  );
  const data = useMemo(() => nodeData(content), [content]);
  const selected = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const nodes = useMemo(
    () => toFlowNodes(content.nodes, data, positions, view.visible, selected, movable && !preview),
    [content, data, movable, positions, preview, selected, view.visible],
  );
  const edges = useMemo(() => toFlowEdges(content, view.visible), [content, view.visible]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moved: Record<string, XY> = {};
      const moving: Record<string, XY> = {};
      let selection: string[] | null = null;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (change.dragging) moving[change.id] = change.position;
          else moved[change.id] = change.position;
        } else if (change.type === 'select') {
          const current: string[] = selection ?? store.getState().selectedNodeIds;
          selection = change.selected
            ? [...current.filter((id) => id !== change.id), change.id]
            : current.filter((id) => id !== change.id);
        }
      }
      if (Object.keys(moving).length > 0) setDragging((old) => ({ ...old, ...moving }));
      if (Object.keys(moved).length > 0) {
        setDragging((old) =>
          Object.fromEntries(Object.entries(old).filter(([id]) => !(id in moved))),
        );
        save(moved);
      }
      if (selection) store.getState().select(selection, 'canvas');
    },
    [save, store],
  );

  // A node picked in the Nodes list is brought into view on the canvas: only when the selection
  // changes, so the latest positions are read through a ref rather than being a dependency.
  const placement = useRef({ positions, visible: view.visible });
  useEffect(() => {
    placement.current = { positions, visible: view.visible };
  }, [positions, view.visible]);
  useEffect(() => {
    if (selectionSource !== 'list') return;
    const id = selectedNodeIds.at(-1);
    const position = id ? placement.current.positions[id] : undefined;
    if (!id || !position || !placement.current.visible.has(id)) return;
    void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
      zoom: flow.getZoom(),
    });
  }, [flow, selectedNodeIds, selectionSource]);

  const primary = selectedNodeIds.at(-1) ?? null;
  const selectedVisible = selectedNodeIds.filter((id) => view.visible.has(id));

  function startArrange() {
    const ids = selectedVisible;
    const previous: Record<string, XY> = {};
    for (const id of ids) {
      const position = positions[id];
      if (position) previous[id] = position;
    }
    setArrangeMessage('');
    setPreview({ ids, previous, proposed: arrange(ids, content, positions) });
  }

  /** Set when a preview closes, so focus returns to Arrange once it is enabled again. */
  const returnToArrange = useRef(false);
  useEffect(() => {
    if (preview) applyButton.current?.focus();
    else if (returnToArrange.current) {
      returnToArrange.current = false;
      arrangeButton.current?.focus();
    }
  }, [preview]);

  function cancelArrange() {
    returnToArrange.current = true;
    setPreview(null);
  }

  function applyArrange() {
    if (!preview) return;
    save(preview.proposed, { arrangement: true });
    setLastArrangement(preview);
    setPreview(null);
    setArrangeMessage(GRAPH_COPY.applied);
    returnToArrange.current = true;
  }

  function undoArrange() {
    if (!lastArrangement) return;
    save(lastArrangement.previous, { arrangement: true });
    setLastArrangement(null);
    setArrangeMessage(GRAPH_COPY.undone);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    if (preview) {
      event.preventDefault();
      cancelArrange();
    } else if (selectedNodeIds.length > 0) {
      store.getState().select([], 'canvas');
    }
  }

  const tooMany = selectedVisible.length > MAX_ARRANGE_NODES;
  const summary = [
    visibilityText(graph.nodes.length, view, focus !== null),
    ...(selectedNodeIds.length > 0
      ? [`${selectedNodeIds.length.toLocaleString('en-US')} selected`]
      : []),
  ].join(' · ');

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div role="toolbar" aria-label="Graph tools" className="flex flex-wrap items-center gap-2">
        <ZoomControls />
        <details className="relative">
          <summary className="cursor-pointer rounded border border-muted px-2 py-1">Filter</summary>
          <fieldset className="mt-2 flex flex-col gap-1 rounded border border-muted bg-canvas p-2">
            <legend className="sr-only">Node types shown</legend>
            {STUDY_NODE_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!hiddenTypes.has(type)}
                  onChange={() => store.getState().toggleType(type)}
                />
                {NODE_TYPE_NAMES[type]}
              </label>
            ))}
          </fieldset>
        </details>
        <button
          type="button"
          aria-pressed={!hiddenTypes.has('source')}
          onClick={() => store.getState().toggleType('source')}
          className="rounded border border-muted px-2 py-1 aria-pressed:border-accent"
        >
          Sources
        </button>
        {focus ? (
          <>
            <button
              type="button"
              onClick={() => store.getState().setFocus({ ...focus, depth: focus.depth + 1 })}
              className="rounded border border-muted px-2 py-1"
            >
              Expand
            </button>
            <button
              type="button"
              onClick={() => {
                store.getState().setFocus(null);
                setLargeNotice(false);
              }}
              className="rounded border border-muted px-2 py-1"
            >
              Exit focus
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={selectedNodeIds.length !== 1}
            onClick={() =>
              primary && store.getState().setFocus({ nodeId: primary, depth: FOCUS_DEPTH })
            }
            className="rounded border border-muted px-2 py-1 disabled:opacity-50"
          >
            Focus
          </button>
        )}
        {movable ? (
          <button
            type="button"
            ref={arrangeButton}
            disabled={selectedVisible.length < 2 || tooMany || preview !== null}
            onClick={startArrange}
            className="rounded border border-muted px-2 py-1 disabled:opacity-50"
          >
            Arrange selection
          </button>
        ) : null}
        {movable && tooMany ? <span className="text-sm">{GRAPH_COPY.arrangeLimit}</span> : null}
      </div>

      <p role="status" aria-live="polite" className="text-sm">
        {summary}
      </p>
      {largeNotice ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p>
            This study has {graph.nodes.length.toLocaleString('en-US')} nodes. Showing a focused
            view.
          </p>
          <button
            type="button"
            onClick={() => {
              store.getState().setFocus(null);
              setLargeNotice(false);
            }}
            className="underline"
          >
            Show all
          </button>
        </div>
      ) : null}
      {!movable ? (
        <p id={readOnlyId} className="text-sm text-muted">
          {!editable ? GRAPH_COPY.readOnly : GRAPH_COPY.narrow}
        </p>
      ) : null}
      {preview ? (
        <div
          role="group"
          aria-label="Arrangement preview"
          className="flex flex-wrap items-center gap-3"
        >
          <p>
            Previewing arrangement of {preview.ids.length.toLocaleString('en-US')} selected nodes.
          </p>
          <button
            type="button"
            ref={applyButton}
            onClick={applyArrange}
            className="rounded border border-accent px-2 py-1 text-accent"
          >
            Apply
          </button>
          <button type="button" onClick={cancelArrange} className="rounded border px-2 py-1">
            Cancel
          </button>
        </div>
      ) : null}
      {arrangeMessage ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p role="status">{arrangeMessage}</p>
          {lastArrangement && movable ? (
            <button type="button" onClick={undoArrange} className="underline">
              Undo arrangement
            </button>
          ) : null}
        </div>
      ) : null}
      <LayoutIndicator
        status={saver.status}
        onRetry={saver.retry}
        onReload={() => void saver.reload()}
      />

      <p id={instructionsId} className="sr-only">
        {movable ? GRAPH_COPY.instructions : GRAPH_COPY.readOnlyInstructions}
      </p>
      <div
        role="group"
        aria-label="Study graph"
        // Read-only: the reason (archived, trashed or narrow) is part of the description.
        aria-describedby={movable ? instructionsId : `${instructionsId} ${readOnlyId}`}
        className="h-[min(70vh,720px)] min-h-[420px] w-full rounded border border-muted"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          minZoom={0.25}
          maxZoom={2}
          fitView
          nodesDraggable={movable && !preview}
          nodesConnectable={false}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode="Shift"
          disableKeyboardA11y={false}
          onlyRenderVisibleElements={nodes.length > 100}
        >
          <Background />
          <MiniMap ariaLabel="Graph overview" pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

const zoomSelector = (state: { transform: [number, number, number] }) =>
  Math.round(state.transform[2] * 100);

/** Native buttons for the canvas viewport, so none of it needs a mouse or a gesture. */
function ZoomControls() {
  const flow = useReactFlow();
  const zoom = useFlowStore(zoomSelector);
  const selectedIds = useGraphView((s) => s.selectedNodeIds);
  return (
    <>
      <button
        type="button"
        onClick={() => void flow.zoomOut()}
        className="rounded border border-muted px-2 py-1"
      >
        Zoom out
      </button>
      <span className="min-w-[4ch] text-center text-sm" aria-live="off">
        {zoom}%
      </span>
      <button
        type="button"
        onClick={() => void flow.zoomIn()}
        className="rounded border border-muted px-2 py-1"
      >
        Zoom in
      </button>
      <button
        type="button"
        onClick={() => void flow.fitView()}
        className="rounded border border-muted px-2 py-1"
      >
        Fit all
      </button>
      <button
        type="button"
        disabled={selectedIds.length === 0}
        onClick={() => void flow.fitView({ nodes: selectedIds.map((id) => ({ id })) })}
        className="rounded border border-muted px-2 py-1 disabled:opacity-50"
      >
        Fit selection
      </button>
    </>
  );
}

/**
 * "Saving layout…" / "Layout saved" / "Layout not saved" (Retry) / another tab (Reload) / moved
 * nodes deleted elsewhere. "Layout saved" only when nothing local is unsaved.
 */
function LayoutIndicator({
  status,
  onRetry,
  onReload,
}: {
  status: LayoutSaveStatus;
  onRetry: () => void;
  onReload: () => void;
}) {
  const text =
    status.state === 'saving'
      ? 'Saving layout…'
      : status.state === 'saved'
        ? 'Layout saved'
        : status.state === 'failed'
          ? 'Layout not saved.'
          : status.state === 'conflict'
            ? "Couldn't save the layout: it changed in another tab."
            : status.state === 'removed'
              ? 'Some moved nodes were removed elsewhere.'
              : '';
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <p role="status">{text}</p>
      {status.state === 'failed' ? (
        <button type="button" onClick={onRetry} className="underline">
          Retry
        </button>
      ) : null}
      {status.state === 'conflict' ? (
        <button type="button" onClick={onReload} className="underline">
          Reload
        </button>
      ) : null}
    </div>
  );
}
