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
  type Connection,
  ConnectionMode,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
} from '@xyflow/react';
import {
  Component,
  type KeyboardEvent,
  type ReactNode,
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
import { type GraphViewMode, useGraphView, useGraphViewStore } from '@/lib/graph-store';
import {
  arrange,
  fallbackPositions,
  FOCUS_DEPTH,
  focusStart,
  isValidConnection,
  MAX_ARRANGE_NODES,
  MIN_EDIT_WIDTH,
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
import { nodeOptionText } from '@/lib/nodes';
import { stepBack, stepForward } from '@/lib/selection-history';
import {
  CONNECT_COPY,
  ConnectDialog,
  type ConnectOutcome,
  type ConnectPrefill,
} from './connect-dialog';
import { GraphListView } from './graph-list-view';
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
  locked:
    'This study was archived or moved to the trash somewhere else, so nothing was saved. Reload to see it.',
  selectToConnect: 'Select one or two nodes to connect.',
  arrangeInList: 'Switch to Graph to preview an arrangement.',
  drawFailed: "The graph couldn't be drawn.",
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "Couldn't load the graph. The Nodes list below still has everything.",
  refused: "Couldn't load the graph. The Nodes list below still has everything.",
  unavailable: "Couldn't load the graph. The Nodes list below still has everything.",
};

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
 *
 * BIB-29: the same snapshot also shows as List View (the default below 900 px), with Back /
 * Forward through recently selected nodes and the Connect dialog (toolbar, List View rows, and a
 * drop between two canvas handles).
 */
export function GraphSection({
  study,
  onReload,
}: {
  study: StudyResponse;
  /** Re-reads the study (the locked alert's Reload). */
  onReload?: () => Promise<unknown>;
}) {
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
              <GraphCanvas study={study} graph={graph.data} onReload={onReload} />
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

interface OpenConnect {
  prefill: ConnectPrefill;
  /** The control that opened the dialog, which takes focus back when it closes. */
  opener: HTMLElement | null;
}

function GraphCanvas({
  study,
  graph,
  onReload,
}: {
  study: StudyResponse;
  graph: GraphResponse;
  onReload: (() => Promise<unknown>) | undefined;
}) {
  const store = useGraphViewStore();
  const flow = useReactFlow();
  const instructionsId = useId();
  const readOnlyId = useId();
  const connectReasonId = useId();
  const arrangeReasonId = useId();
  const selectedNodeIds = useGraphView((s) => s.selectedNodeIds);
  const selectionSource = useGraphView((s) => s.selectionSource);
  const hiddenTypes = useGraphView((s) => s.hiddenTypes);
  const focus = useGraphView((s) => s.focus);
  const localPositions = useGraphView((s) => s.localPositions);
  const history = useGraphView((s) => s.history);
  const viewMode = useGraphView((s) => s.viewMode);
  const wide = useWideViewport();
  /** The study revision a lifecycle refusal arrived at: read-only until the study reloads. */
  const [lockedAt, setLockedAt] = useState<number | null>(null);
  const lock = useCallback(() => setLockedAt(study.revision), [study.revision]);
  const locked = lockedAt === study.revision;
  const editable = study.lifecycle === 'active' && !locked;
  const movable = editable && wide;
  /** Polite announcements: the view switched, Back / Forward selected a node, a relationship added. */
  const [announcement, setAnnouncement] = useState('');
  const [connect, setConnect] = useState<OpenConnect | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const lockedAlert = useRef<HTMLDivElement>(null);
  /** After a Connect refused for the study's lifecycle: the locked alert takes focus. */
  const focusLocked = useRef(false);
  /** After "Open List View" (the canvas failed to draw): the List heading takes focus. */
  const focusList = useRef(false);
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
  // Handles start a drag-to-connect only where nodes can be moved too (editable and wide).
  const connectable = movable && !preview && graph.nodes.length >= 2;
  const nodes = useMemo(
    () =>
      toFlowNodes(
        content.nodes,
        data,
        positions,
        view.visible,
        selected,
        movable && !preview,
        connectable,
      ),
    [connectable, content, data, movable, positions, preview, selected, view.visible],
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
    if (selectionSource !== 'list' || store.getState().viewMode !== 'graph') return;
    const id = selectedNodeIds.at(-1);
    const position = id ? placement.current.positions[id] : undefined;
    if (!id || !position || !placement.current.visible.has(id)) return;
    void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
      zoom: flow.getZoom(),
    });
  }, [flow, selectedNodeIds, selectionSource, store]);

  useEffect(() => {
    if (!locked || !focusLocked.current) return;
    focusLocked.current = false;
    lockedAlert.current?.focus();
  }, [locked]);

  useEffect(() => {
    if (viewMode !== 'list' || !focusList.current) return;
    focusList.current = false;
    listHeading.current?.focus();
  }, [viewMode]);

  function switchView(mode: GraphViewMode) {
    if (mode === store.getState().viewMode) return;
    // An arrangement preview is drawn on the canvas only.
    if (mode === 'list') setPreview(null);
    store.getState().setViewMode(mode);
    setAnnouncement(mode === 'list' ? 'List view' : 'Graph view');
  }

  function openListView() {
    focusList.current = true;
    switchView('list');
  }

  // Back / Forward: entries for nodes no longer in the snapshot are skipped.
  const live = useMemo(() => new Set(graph.nodes.map((node) => node.id)), [graph.nodes]);
  const canGoBack = stepBack(history, live).id !== null;
  const canGoForward = stepForward(history, live).id !== null;
  function goHistory(delta: -1 | 1) {
    const id = store.getState().stepHistory(delta, live);
    const node = id ? graph.nodes.find((candidate) => candidate.id === id) : undefined;
    if (node) setAnnouncement(`Selected ${nodeOptionText(node)}`);
  }

  function openConnect(prefill: ConnectPrefill, opener: HTMLElement | null) {
    setAnnouncement('');
    setConnect({ prefill, opener });
  }

  function connectClosed(outcome: ConnectOutcome) {
    const opener = connect?.opener;
    setConnect(null);
    if (outcome === 'locked') {
      focusLocked.current = true;
      lock();
      return;
    }
    if (outcome === 'created') setAnnouncement(CONNECT_COPY.added);
    const target = opener?.isConnected ? opener : (canvasRef.current ?? listHeading.current);
    target?.focus();
  }

  /** A drop between two handles only opens the dialog, prefilled: it never adds an edge itself. */
  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return;
    const source = Array.from(
      canvasRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [],
    ).find((element) => element.dataset.id === connection.source);
    setAnnouncement('');
    setConnect({
      prefill: { fromId: connection.source, toId: connection.target },
      opener: source ?? canvasRef.current,
    });
  }, []);

  function toggleSelected(nodeId: string) {
    const current = store.getState().selectedNodeIds;
    // Like Shift+click on the canvas: no panning, and an unsaved edit in detail stays open.
    store
      .getState()
      .select(
        current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId],
        'canvas',
      );
  }

  const connectReason =
    graph.nodes.length < 2
      ? CONNECT_COPY.noOther
      : selectedNodeIds.length < 1 || selectedNodeIds.length > 2
        ? GRAPH_COPY.selectToConnect
        : null;

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
      <div role="group" aria-label="View" className="flex flex-wrap items-center gap-2">
        {(['graph', 'list'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={viewMode === mode}
            onClick={() => switchView(mode)}
            className="rounded border border-muted px-2 py-1 aria-pressed:border-2 aria-pressed:border-accent aria-pressed:font-semibold"
          >
            {mode === 'graph' ? 'Graph' : 'List'}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div role="toolbar" aria-label="Graph tools" className="flex flex-wrap items-center gap-2">
        {viewMode === 'graph' ? <ZoomControls /> : null}
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
        <button
          type="button"
          aria-label="Back to previously selected node"
          disabled={!canGoBack}
          onClick={() => goHistory(-1)}
          className="rounded border border-muted px-2 py-1 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          aria-label="Forward to next selected node"
          disabled={!canGoForward}
          onClick={() => goHistory(1)}
          className="rounded border border-muted px-2 py-1 disabled:opacity-50"
        >
          Forward
        </button>
        {editable ? (
          <>
            <button
              type="button"
              aria-haspopup="dialog"
              disabled={connectReason !== null}
              aria-describedby={connectReason ? connectReasonId : undefined}
              onClick={(event) =>
                openConnect(
                  { fromId: selectedNodeIds[0] ?? null, toId: selectedNodeIds[1] ?? null },
                  event.currentTarget,
                )
              }
              className="rounded border border-accent px-2 py-1 text-accent disabled:opacity-50"
            >
              Connect…
            </button>
            {connectReason ? (
              <span id={connectReasonId} className="text-sm">
                {connectReason}
              </span>
            ) : null}
          </>
        ) : null}
        {movable ? (
          <button
            type="button"
            ref={arrangeButton}
            disabled={
              viewMode === 'list' || selectedVisible.length < 2 || tooMany || preview !== null
            }
            aria-describedby={viewMode === 'list' ? arrangeReasonId : undefined}
            onClick={startArrange}
            className="rounded border border-muted px-2 py-1 disabled:opacity-50"
          >
            Arrange selection
          </button>
        ) : null}
        {movable && viewMode === 'list' ? (
          <span id={arrangeReasonId} className="text-sm">
            {GRAPH_COPY.arrangeInList}
          </span>
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
      {locked ? (
        <div
          role="alert"
          ref={lockedAlert}
          tabIndex={-1}
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <p id={readOnlyId}>{GRAPH_COPY.locked}</p>
          {onReload ? (
            <button type="button" onClick={() => void onReload()} className="underline">
              Reload
            </button>
          ) : null}
        </div>
      ) : !movable ? (
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

      {viewMode === 'graph' ? (
        <>
          <p id={instructionsId} className="sr-only">
            {movable ? GRAPH_COPY.instructions : GRAPH_COPY.readOnlyInstructions}
          </p>
          <CanvasErrorBoundary onOpenList={openListView}>
            <div
              role="group"
              aria-label="Study graph"
              ref={canvasRef}
              // Focus lands here when the node a drop started from is gone.
              tabIndex={-1}
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
                nodesConnectable={connectable}
                connectionMode={ConnectionMode.Strict}
                isValidConnection={isValidConnection}
                onConnect={onConnect}
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
          </CanvasErrorBoundary>
        </>
      ) : (
        <GraphListView
          nodes={graph.nodes}
          edges={graph.edges}
          visible={view.visible}
          selectedNodeIds={selectedNodeIds}
          canConnect={editable}
          headingRef={listHeading}
          onToggle={toggleSelected}
          onOpen={(nodeId) => store.getState().select([nodeId], 'list', { focusDetail: true })}
          onConnect={(nodeId, opener) => openConnect({ fromId: nodeId, toId: null }, opener)}
        />
      )}
      {connect && editable ? (
        <ConnectDialog
          studyId={study.id}
          studyRevision={study.revision}
          nodes={graph.nodes}
          prefill={connect.prefill}
          onClose={connectClosed}
        />
      ) : null}
    </div>
  );
}

/**
 * When the canvas itself can't be drawn (PRD section 11: "error offers List View"), the same
 * snapshot is still readable as List View. A failed fetch is the section's ProblemAlert instead.
 */
class CanvasErrorBoundary extends Component<
  { children: ReactNode; onOpenList: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded border border-muted p-4"
      >
        <p>{GRAPH_COPY.drawFailed}</p>
        <button
          type="button"
          onClick={this.props.onOpenList}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Open List View
        </button>
      </div>
    );
  }
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
