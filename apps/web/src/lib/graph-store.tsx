'use client';

import type { StudyNodeType } from '@bible-artisan/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';
import type { FocusOption, Positions, XY } from './graph-view';

/**
 * One study page's canvas interaction state (BIB-28, AGENTS.md: "canvas selection, drafts, and
 * the pending-save queue go in a lightweight client store"). It holds no server data and no text:
 * node ids, view options and coordinates only, in memory for the page session (never in the URL
 * or browser storage). Saved zoom, filters and selection are BIB-34's.
 */
export interface GraphViewState {
  /** Shared by the canvas and the Nodes list; the last one is the node whose detail is open. */
  selectedNodeIds: string[];
  /** Where the latest selection came from: the list pans the canvas, the canvas never steals focus. */
  selectionSource: 'canvas' | 'list';
  hiddenTypes: ReadonlySet<StudyNodeType>;
  focus: FocusOption | null;
  /** Positions moved or arranged in this session, over the snapshot's (saved or not yet). */
  localPositions: Positions;
  /** Node ids whose local position still has to be saved (the pending-save queue). */
  pendingIds: ReadonlySet<string>;

  select: (ids: string[], source: 'canvas' | 'list') => void;
  toggleType: (type: StudyNodeType) => void;
  setFocus: (focus: FocusOption | null) => void;
  /** Places nodes locally and queues them for saving. */
  move: (positions: Record<string, XY>) => void;
  /** Takes up to `max` queued ids off the queue (oldest first) for one request. */
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
    hiddenTypes: new Set(),
    focus: null,
    localPositions: {},
    pendingIds: new Set(),

    select: (ids, source) => set({ selectedNodeIds: ids, selectionSource: source }),
    toggleType: (type) =>
      set(({ hiddenTypes }) => {
        const next = new Set(hiddenTypes);
        if (!next.delete(type)) next.add(type);
        return { hiddenTypes: next };
      }),
    setFocus: (focus) => set({ focus }),
    move: (positions) =>
      set(({ localPositions, pendingIds }) => ({
        localPositions: { ...localPositions, ...positions },
        pendingIds: new Set([...pendingIds, ...Object.keys(positions)]),
      })),
    takePending: (max) => {
      const ids = [...get().pendingIds].slice(0, max);
      set(({ pendingIds }) => {
        const next = new Set(pendingIds);
        for (const id of ids) next.delete(id);
        return { pendingIds: next };
      });
      return ids;
    },
    requeue: (ids) => set(({ pendingIds }) => ({ pendingIds: new Set([...ids, ...pendingIds]) })),
    forget: (ids) =>
      set(({ localPositions, pendingIds }) => {
        const gone = new Set(ids);
        return {
          localPositions: Object.fromEntries(
            Object.entries(localPositions).filter(([id]) => !gone.has(id)),
          ),
          pendingIds: new Set([...pendingIds].filter((id) => !gone.has(id))),
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
