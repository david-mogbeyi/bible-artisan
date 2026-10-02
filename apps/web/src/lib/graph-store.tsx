'use client';

import type { StudyNodeType } from '@bible-artisan/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';
import { type FocusOption, MIN_EDIT_WIDTH, type Positions, type XY } from './graph-view';
import {
  EMPTY_HISTORY,
  pushSelection,
  type SelectionHistory,
  stepBack,
  stepForward,
} from './selection-history';

/** The Graph section's two presentations of the same snapshot (BIB-29). */
export type GraphViewMode = 'graph' | 'list';

/** List below the canvas's editing width, where the canvas is read-only (NFR-ACCESS-003). */
function defaultViewMode(): GraphViewMode {
  return typeof window !== 'undefined' && window.innerWidth < MIN_EDIT_WIDTH ? 'list' : 'graph';
}

/**
 * One study page's canvas interaction state (BIB-28, AGENTS.md: "canvas selection, drafts, and
 * the pending-save queue go in a lightweight client store"). It holds no server data and no text:
 * node ids, view options and coordinates only, in memory for the page session (never in the URL
 * or browser storage). Saved zoom, filters and selection are BIB-34's.
 */
export interface GraphViewState {
  /**
   * Shared by the canvas, List View and the Nodes list, in selection order; the last one is the
   * node whose detail is open.
   */
  selectedNodeIds: string[];
  /**
   * Where the latest selection came from. 'list': an explicit pick (the Nodes list, List View's
   * Open and Show, Back / Forward) that pans the canvas to it. 'canvas': a canvas click or a List
   * View checkbox, which never pans or steals focus and keeps an unsaved node edit open.
   */
  selectionSource: 'canvas' | 'list';
  /** The selection asked for the open node's detail heading to take focus once it loads. */
  focusDetail: boolean;
  /** Back / Forward (BIB-29): every change to exactly one node, from any source. */
  history: SelectionHistory;
  /** Canvas or List View (BIB-29). */
  viewMode: GraphViewMode;
  hiddenTypes: ReadonlySet<StudyNodeType>;
  focus: FocusOption | null;
  /** Positions moved or arranged in this session, over the snapshot's (saved or not yet). */
  localPositions: Positions;
  /** Node ids whose local position still has to be saved (the pending-save queue), oldest first. */
  pendingIds: ReadonlySet<string>;
  /** The latest arrangement's ids still queued: they are saved together, in one request. */
  pendingGroup: ReadonlySet<string>;

  select: (ids: string[], source: 'canvas' | 'list', options?: { focusDetail?: boolean }) => void;
  /** The detail heading took focus (or no longer should). */
  detailFocused: () => void;
  /**
   * Selects the previous (`-1`) or next (`+1`) history entry still in the snapshot, without adding
   * one. Returns the selected id, or null at that end.
   */
  stepHistory: (delta: -1 | 1, live: ReadonlySet<string>) => string | null;
  setViewMode: (mode: GraphViewMode) => void;
  toggleType: (type: StudyNodeType) => void;
  setFocus: (focus: FocusOption | null) => void;
  /**
   * Places nodes locally and queues them for saving. `together` (an arrangement, at most one
   * request's worth) queues them as one group, after everything queued before.
   */
  move: (positions: Record<string, XY>, options?: { together?: boolean }) => void;
  /**
   * Takes up to `max` queued ids off the queue (oldest first) for one request, never splitting
   * the group: when everything fits it all goes at once; otherwise the earlier moves go first and
   * the group goes on its own.
   */
  takePending: (max: number) => string[];
  /** Puts ids back on the queue (a request that must be resent). */
  requeue: (ids: readonly string[]) => void;
  /** Forgets local positions (and queued saves) of these nodes: the server's layout wins. */
  forget: (ids: readonly string[]) => void;
}

export type GraphViewStore = StoreApi<GraphViewState>;

export function createGraphViewStore(): GraphViewStore {
  return createStore<GraphViewState>()((set, get) => ({
    selectedNodeIds: [],
    selectionSource: 'canvas',
    focusDetail: false,
    history: EMPTY_HISTORY,
    viewMode: defaultViewMode(),
    hiddenTypes: new Set(),
    focus: null,
    localPositions: {},
    pendingIds: new Set(),
    pendingGroup: new Set(),

    select: (ids, source, { focusDetail = false } = {}) =>
      set(({ history }) => ({
        selectedNodeIds: ids,
        selectionSource: source,
        focusDetail,
        // Multi-select and clearing neither add an entry nor drop the forward ones.
        history: ids.length === 1 ? pushSelection(history, ids[0] as string) : history,
      })),
    detailFocused: () => set({ focusDetail: false }),
    stepHistory: (delta, live) => {
      const { history } = get();
      const next = (delta === -1 ? stepBack : stepForward)(history, live);
      set(
        next.id
          ? {
              history: next.history,
              selectedNodeIds: [next.id],
              selectionSource: 'list',
              focusDetail: false,
            }
          : { history: next.history },
      );
      return next.id;
    },
    setViewMode: (viewMode) => set({ viewMode }),
    toggleType: (type) =>
      set(({ hiddenTypes }) => {
        const next = new Set(hiddenTypes);
        if (!next.delete(type)) next.add(type);
        return { hiddenTypes: next };
      }),
    setFocus: (focus) => set({ focus }),
    move: (positions, { together = false } = {}) =>
      set(({ localPositions, pendingIds, pendingGroup }) => {
        const ids = Object.keys(positions);
        const moved = new Set(ids);
        return {
          localPositions: { ...localPositions, ...positions },
          pendingIds: together
            ? new Set([...[...pendingIds].filter((id) => !moved.has(id)), ...ids])
            : new Set([...pendingIds, ...ids]),
          pendingGroup: together ? moved : pendingGroup,
        };
      }),
    takePending: (max) => {
      const { pendingIds, pendingGroup } = get();
      const queued = [...pendingIds];
      const earlier = queued.filter((id) => !pendingGroup.has(id));
      const ids =
        queued.length <= max || earlier.length === 0 ? queued.slice(0, max) : earlier.slice(0, max);
      const taken = new Set(ids);
      set({
        pendingIds: new Set(queued.filter((id) => !taken.has(id))),
        pendingGroup: new Set([...pendingGroup].filter((id) => !taken.has(id))),
      });
      return ids;
    },
    requeue: (ids) => set(({ pendingIds }) => ({ pendingIds: new Set([...ids, ...pendingIds]) })),
    forget: (ids) =>
      set(({ localPositions, pendingIds, pendingGroup }) => {
        const gone = new Set(ids);
        return {
          localPositions: Object.fromEntries(
            Object.entries(localPositions).filter(([id]) => !gone.has(id)),
          ),
          pendingIds: new Set([...pendingIds].filter((id) => !gone.has(id))),
          pendingGroup: new Set([...pendingGroup].filter((id) => !gone.has(id))),
        };
      }),
  }));
}

const GraphViewContext = createContext<GraphViewStore | null>(null);

/** One store per study page, shared by its Graph and Nodes sections. */
export function GraphViewProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createGraphViewStore);
  return <GraphViewContext.Provider value={store}>{children}</GraphViewContext.Provider>;
}

export function useGraphViewStore(): GraphViewStore {
  const store = useContext(GraphViewContext);
  if (!store) throw new Error('useGraphViewStore needs a GraphViewProvider');
  return store;
}

export function useGraphView<T>(selector: (state: GraphViewState) => T): T {
  return useStore(useGraphViewStore(), selector);
}
