'use client';

import {
  type EdgeType,
  NODE_TYPE_NAMES,
  type StudyNodeType,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';
import { deleteEdge, listEdges, restoreEdge, updateEdge } from './edges';
import { deleteNode, restoreNode, updateNode } from './nodes';

/**
 * Undo and redo of recent graph and content commands (BIB-63; PRD section 12, FR-GRAPH-012).
 *
 * Per tab, in memory only (never persisted): the last `MAX_UNDO` commands the server acknowledged.
 * An undo never rewrites history: it sends a compensating mutation (delete what was added, restore
 * what was deleted, PATCH back what was edited) that records its own ordinary event. Each one
 * sends the entity revision this tab last acknowledged, so a change made elsewhere since is a 409
 * and nothing is overwritten: the command is dropped and the user is told to resolve it by hand.
 *
 * Entries carry ids, enums and the previous content to restore, never anything a log could see;
 * labels are fixed words ("Add observation"), never a node's text.
 */

export const MAX_UNDO = 50;

/** An edit's fields without `expectedRevision` (added when the action runs). */
export type NodeEdit = Omit<UpdateNodeRequest, 'expectedRevision'>;
export interface EdgeEdit {
  type?: EdgeType;
  note?: string | null;
}

/** One compensating (or re-applying) mutation. `sourceNodeId` finds a live edge's revision. */
export type UndoAction =
  | { op: 'deleteNode'; nodeId: string }
  | { op: 'restoreNode'; nodeId: string }
  | { op: 'editNode'; nodeId: string; body: NodeEdit; inverse: NodeEdit }
  | { op: 'removeEdge'; edgeId: string; sourceNodeId: string }
  | { op: 'restoreEdge'; edgeId: string; sourceNodeId: string }
  | { op: 'editEdge'; edgeId: string; sourceNodeId: string; body: EdgeEdit; inverse: EdgeEdit };

export interface UndoEntry {
  /** What the original command did, in fixed words: "Add observation". */
  label: string;
  /** The mutation that reverses it (on the undo stack) or re-applies it (on the redo stack). */
  action: UndoAction;
  /** Set after an unknown outcome, so the next press resends the same request. */
  key?: string;
}

/** The action that reverses `action`. */
export function inverseOf(action: UndoAction): UndoAction {
  switch (action.op) {
    case 'deleteNode':
      return { op: 'restoreNode', nodeId: action.nodeId };
    case 'restoreNode':
      return { op: 'deleteNode', nodeId: action.nodeId };
    case 'editNode':
      return { ...action, body: action.inverse, inverse: action.body };
    case 'removeEdge':
      return { op: 'restoreEdge', edgeId: action.edgeId, sourceNodeId: action.sourceNodeId };
    case 'restoreEdge':
      return { op: 'removeEdge', edgeId: action.edgeId, sourceNodeId: action.sourceNodeId };
    case 'editEdge':
      return { ...action, body: action.inverse, inverse: action.body };
  }
}

export const nodeKey = (id: string) => `node:${id}`;
export const edgeKey = (id: string) => `edge:${id}`;

/** Revisions acknowledged by this tab, by `nodeKey` / `edgeKey`; null forgets one. */
export type RevisionUpdates = Record<string, number | null>;

/**
 * A node's deletion or restore moves the revision of every live edge touching it without naming
 * them, so every edge revision this tab knows is forgotten: an edge action then reads the live
 * edge's revision instead (`liveEdgeRevision`).
 */
export const FORGET_EDGES = '*edges';

export interface UndoState {
  undo: UndoEntry[];
  redo: UndoEntry[];
  revisions: Record<string, number>;
  /** An undo or redo is in flight: both buttons wait. */
  busy: boolean;
  /** A new acknowledged command: pushed on the undo stack (the oldest past `MAX_UNDO` goes), redo cleared. */
  record: (entry: UndoEntry, revisions: RevisionUpdates) => void;
  setBusy: (busy: boolean) => void;
  /** After an undo or redo: `from` loses its top entry, `to` gains `moved` (if any). */
  settle: (from: 'undo' | 'redo', moved: UndoEntry | null, revisions: RevisionUpdates) => void;
  /** An unknown outcome: the top entry keeps its request key for the next press. */
  keepKey: (from: 'undo' | 'redo', key: string) => void;
}

function applyRevisions(current: Record<string, number>, updates: RevisionUpdates) {
  const next =
    updates[FORGET_EDGES] !== undefined
      ? Object.fromEntries(Object.entries(current).filter(([k]) => !k.startsWith('edge:')))
      : { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (key === FORGET_EDGES) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function createUndoStore(): StoreApi<UndoState> {
  return createStore<UndoState>()((set) => ({
    undo: [],
    redo: [],
    revisions: {},
    busy: false,
    record: (entry, revisions) =>
      set((s) => ({
        undo: [...s.undo, entry].slice(-MAX_UNDO),
        redo: [],
        revisions: applyRevisions(s.revisions, revisions),
      })),
    setBusy: (busy) => set({ busy }),
    settle: (from, moved, revisions) =>
      set((s) => {
        const to = from === 'undo' ? 'redo' : 'undo';
        const target = moved ? [...s[to], moved].slice(-MAX_UNDO) : s[to];
        return {
          [from]: s[from].slice(0, -1),
          [to]: target,
          revisions: applyRevisions(s.revisions, revisions),
        };
      }),
    keepKey: (from, key) =>
      set((s) => {
        const top = s[from].at(-1);
        if (!top) return {};
        return { [from]: [...s[from].slice(0, -1), { ...top, key }] };
      }),
  }));
}

const UndoContext = createContext<StoreApi<UndoState> | null>(null);

/** One per study page (inside `GraphViewProvider`), so it lives as long as the tab's page. */
export function UndoProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createUndoStore);
  return <UndoContext.Provider value={store}>{children}</UndoContext.Provider>;
}

export function useUndoStore(): StoreApi<UndoState> | null {
  return useContext(UndoContext);
}

const NO_STORE = createUndoStore();

export function useUndo<T>(selector: (state: UndoState) => T): T {
  return useStore(useUndoStore() ?? NO_STORE, selector);
}

/**
 * Records an acknowledged command. Outside a study page (the reader's Add to study, the Notes
 * panel) there is no undo stack and this does nothing.
 */
export function useUndoRecorder(): (entry: UndoEntry, revisions: RevisionUpdates) => void {
  const store = useUndoStore();
  return (entry, revisions) => store?.getState().record(entry, revisions);
}

/** "Add observation", "Delete conclusion": fixed words, never a node's text. */
export function nodeCommandLabel(verb: string, type: StudyNodeType): string {
  return `${verb} ${NODE_TYPE_NAMES[type].toLowerCase()}`;
}

/** Thrown when the entity to act on is gone or unknown: treated as the server's 404. */
export class UndoTargetGoneError extends Error {
  constructor() {
    super('undo target gone');
    this.name = 'UndoTargetGoneError';
  }
}

async function liveEdgeRevision(studyId: string, sourceNodeId: string, edgeId: string) {
  const { items } = await listEdges(studyId, sourceNodeId);
  const edge = items.find((item) => item.id === edgeId);
  if (!edge) throw new UndoTargetGoneError();
  return edge.revision;
}

/**
 * Sends one action with the revision this tab knows (or, for a live edge whose revision was
 * forgotten, the live one) and returns the revisions it acknowledged.
 */
export async function performUndoAction(
  studyId: string,
  action: UndoAction,
  revisions: Record<string, number>,
  key: string,
): Promise<RevisionUpdates> {
  const known = (k: string) => revisions[k];
  switch (action.op) {
    case 'deleteNode':
    case 'restoreNode': {
      const expectedRevision = known(nodeKey(action.nodeId));
      if (expectedRevision === undefined) throw new UndoTargetGoneError();
      const send = action.op === 'deleteNode' ? deleteNode : restoreNode;
      const result = await send(studyId, action.nodeId, { expectedRevision }, key);
      return { [nodeKey(action.nodeId)]: result.revision, [FORGET_EDGES]: null };
    }
    case 'editNode': {
      const expectedRevision = known(nodeKey(action.nodeId));
      if (expectedRevision === undefined) throw new UndoTargetGoneError();
      const result = await updateNode(
        studyId,
        action.nodeId,
        { ...action.body, expectedRevision },
        key,
      );
      return { [nodeKey(action.nodeId)]: result.revision };
    }
    case 'restoreEdge': {
      const expectedRevision = known(edgeKey(action.edgeId));
      if (expectedRevision === undefined) throw new UndoTargetGoneError();
      const result = await restoreEdge(studyId, action.edgeId, { expectedRevision }, key);
      return { [edgeKey(action.edgeId)]: result.revision };
    }
    case 'removeEdge':
    case 'editEdge': {
      const expectedRevision =
        known(edgeKey(action.edgeId)) ??
        (await liveEdgeRevision(studyId, action.sourceNodeId, action.edgeId));
      const result =
        action.op === 'removeEdge'
          ? await deleteEdge(studyId, action.edgeId, { expectedRevision }, key)
          : await updateEdge(studyId, action.edgeId, { ...action.body, expectedRevision }, key);
      return { [edgeKey(action.edgeId)]: result.revision };
    }
  }
}
