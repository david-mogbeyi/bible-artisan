'use client';

import {
  type EdgeType,
  NODE_TYPE_NAMES,
  type NodeDeleteResponse,
  type NodeRestoreResponse,
  type StudyNodeType,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { createStore, type StoreApi, useStore } from 'zustand';
import { deleteEdge, restoreEdge, updateEdge } from './edges';
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

/** One compensating (or re-applying) mutation. */
export type UndoAction =
  | { op: 'deleteNode'; nodeId: string }
  | { op: 'restoreNode'; nodeId: string }
  | { op: 'editNode'; nodeId: string; body: NodeEdit; inverse: NodeEdit }
  | { op: 'removeEdge'; edgeId: string }
  | { op: 'restoreEdge'; edgeId: string }
  | { op: 'editEdge'; edgeId: string; body: EdgeEdit; inverse: EdgeEdit };

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
      return { op: 'restoreEdge', edgeId: action.edgeId };
    case 'restoreEdge':
      return { op: 'removeEdge', edgeId: action.edgeId };
    case 'editEdge':
      return { ...action, body: action.inverse, inverse: action.body };
  }
}

export const nodeKey = (id: string) => `node:${id}`;
export const edgeKey = (id: string) => `edge:${id}`;

/** Revisions acknowledged by this tab, by `nodeKey` / `edgeKey`; null forgets one. */
export type RevisionUpdates = Record<string, number | null>;

/**
 * A node's deletion or restore also moves the revision of every relationship it removed, restored
 * or handed on; the response names each one with its new revision, so this tab keeps tracking them
 * (an undo of a relationship change then sends that revision, and a change made elsewhere is a 409).
 */
export function nodeDeleteRevisions(result: NodeDeleteResponse): RevisionUpdates {
  return {
    [nodeKey(result.id)]: result.revision,
    ...Object.fromEntries(result.removedEdges.map((e) => [edgeKey(e.edgeId), e.revision])),
  };
}

export function nodeRestoreRevisions(result: NodeRestoreResponse): RevisionUpdates {
  return {
    [nodeKey(result.id)]: result.revision,
    ...Object.fromEntries(
      [...result.restoredEdges, ...result.skippedEdges].map((e) => [edgeKey(e.edgeId), e.revision]),
    ),
  };
}

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
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
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

/**
 * Thrown when this tab doesn't know the revision of the entity to act on. The undo is refused
 * rather than sent with the live revision, which would overwrite a change made in another tab.
 */
export class UndoRevisionUnknownError extends Error {
  constructor() {
    super('undo revision unknown');
    this.name = 'UndoRevisionUnknownError';
  }
}

/**
 * Sends one action with the revision this tab acknowledged (never the live one, so a change made
 * elsewhere since is a 409) and returns the revisions it acknowledged.
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
      if (action.op === 'deleteNode') {
        return nodeDeleteRevisions(
          await deleteNode(studyId, action.nodeId, { expectedRevision }, key),
        );
      }
      return nodeRestoreRevisions(
        await restoreNode(studyId, action.nodeId, { expectedRevision }, key),
      );
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
      const expectedRevision = known(edgeKey(action.edgeId));
      if (expectedRevision === undefined) throw new UndoRevisionUnknownError();
      const result =
        action.op === 'removeEdge'
          ? await deleteEdge(studyId, action.edgeId, { expectedRevision }, key)
          : await updateEdge(studyId, action.edgeId, { ...action.body, expectedRevision }, key);
      return { [edgeKey(action.edgeId)]: result.revision };
    }
  }
}
