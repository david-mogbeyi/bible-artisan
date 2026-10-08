'use client';

import {
  EDGE_EXISTS,
  EDGE_TARGET_NOT_QUESTION,
  EDGE_TYPE_NAMES,
  EDGE_UNCHANGED,
  type Edge,
  type EdgeOrigin,
  type EdgeType,
  isSymmetricEdgeType,
  MAX_EDGE_NOTE_LENGTH,
  type NodeSummary,
  sameDirectionClassTypes,
  type StudyNodeType,
  type UpdateEdgeRequest,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import {
  CONNECT_COPY,
  ConnectDialog,
  type ConnectOutcome,
  type ConnectPrefill,
} from '@/components/graph/connect-dialog';
import {
  deleteEdge,
  edgeSentence,
  edgesQueryKey,
  invalidateEdgeChange,
  listEdges,
  otherEnd,
  thisNode,
  updateEdge,
} from '@/lib/edges';
import { invalidateNodeChange, nodeOptionText } from '@/lib/nodes';
import { TextAreaField } from './node-fields';
import {
  codeOf,
  EDGE_RULE_COPY,
  isLifecycle,
  type Problem,
  ProblemLine,
  statusOf,
  TypeSelect,
  useFrozenRequest,
} from './relationship-controls';

export const RELATIONSHIPS_COPY = {
  loading: 'Loading relationships…',
  empty: 'No relationships yet.',
  saved: 'Saved',
  editConflict: 'This relationship changed somewhere else, so your edit was not saved.',
  unknownSave: "Couldn't confirm the edit was saved. Retry won't save it twice.",
  failedSave: "Couldn't save the edit.",
  reloadConfirm: 'Replace your draft with the version saved elsewhere?',
  removeConfirm: 'Remove this relationship? Both nodes stay.',
  removed: 'Relationship removed.',
  removeConflict: 'This relationship changed somewhere else, so it was not removed.',
  unknownRemove: "Couldn't confirm the relationship was removed. Retry won't remove it twice.",
  failedRemove: "Couldn't remove the relationship.",
  alreadyRemoved: 'This relationship was already removed.',
  markerCleared: 'A conclusion it supported is no longer marked Established by me.',
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "This node's relationships aren't available.",
  refused: "Couldn't load the relationships.",
  unavailable: "Couldn't load the relationships.",
};

const ORIGIN_NAMES: Record<EdgeOrigin, string> = { user: 'You', ai: 'AI suggestion you accepted' };

/**
 * The open node's relationships (BIB-27, PRD section 12): each one a sentence from this node's
 * side whose verb states the direction ("This observation supports Conclusion: …", "Romans 8:16
 * supports this observation"), never an arrow or color alone. An active study can connect this
 * node to another (Connect opens the Connect dialog with this node as From, BIB-29), change a
 * relationship's type (same direction class) or note, and remove one. Everything is native buttons
 * and selects; no drag.
 */
export function Relationships({
  studyId,
  node,
  nodes,
  studyRevision,
  editable,
  onLocked,
  onShowNode,
  evidenceConnect = null,
  onEvidenceConnectClosed,
}: {
  studyId: string;
  node: { id: string; type: StudyNodeType };
  /** The study's live nodes (the Nodes list), for labels and the Connect dialog's choices. */
  nodes: NodeSummary[];
  studyRevision: number;
  editable: boolean;
  onLocked: () => void;
  onShowNode: (nodeId: string) => void;
  /**
   * A conclusion's "Connect evidence" (BIB-30) asks for the Connect dialog prefilled with the
   * conclusion as the target; the node detail owns the request, this section hosts the dialog.
   */
  evidenceConnect?: ConnectPrefill | null;
  onEvidenceConnectClosed?: (outcome: ConnectOutcome) => void;
}) {
  const headingId = useId();
  const noOtherId = useId();
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState('');
  const [connecting, setConnecting] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  /** After a removal: the list position whose item (or else Connect) takes focus. */
  const focusAt = useRef<number | null>(null);
  const edges = useQuery({
    queryKey: edgesQueryKey(studyId, node.id),
    queryFn: () => listEdges(studyId, node.id),
  });
  const list = edges.data?.items;

  useEffect(() => {
    if (focusAt.current === null || !list) return;
    const index = Math.min(focusAt.current, list.length - 1);
    focusAt.current = null;
    const next = index >= 0 ? list[index] : undefined;
    if (next) items.current.get(next.id)?.focus();
    else connectButton.current?.focus();
  }, [list]);

  const labelOf = (nodeId: string): string => {
    const other = nodes.find((candidate) => candidate.id === nodeId);
    return other ? nodeOptionText(other) : 'another node in this study';
  };
  const self = thisNode(node.type);
  /** The sentence for `type` between this node and `otherId`, this node first unless `reversed`. */
  const sentence = (type: EdgeType, otherId: string, reversed: boolean) =>
    reversed
      ? edgeSentence(labelOf(otherId), type, self)
      : edgeSentence(self, type, labelOf(otherId));

  const refresh = (edge: Pick<Edge, 'sourceNodeId' | 'targetNodeId'>, cleared: string[] = []) =>
    Promise.all([
      invalidateEdgeChange(queryClient, studyId, edge),
      // A conclusion whose last supporting evidence this change took away lost its marker
      // (BIB-30): its detail, history and the lists are read again.
      ...cleared.map((nodeId) => invalidateNodeChange(queryClient, studyId, nodeId)),
    ]);

  /** The message for a change, with the marker notice when the change cleared one. */
  const said = (message: string, cleared: string[]) =>
    cleared.length > 0 ? `${message} ${RELATIONSHIPS_COPY.markerCleared}` : message;

  function connectClosed(outcome: ConnectOutcome) {
    setConnecting(false);
    if (outcome === 'locked') {
      // The Connect button goes with the study's editability: the section's alert takes focus.
      onLocked();
      return;
    }
    if (outcome === 'created') setAnnouncement(CONNECT_COPY.added);
    connectButton.current?.focus();
  }

  const hasOther = nodes.some((candidate) => candidate.id !== node.id);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h4 id={headingId} className="font-serif text-lg">
        Relationships
      </h4>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {edges.isError ? (
        <ProblemAlert error={edges.error} copy={LOAD_COPY} onRetry={() => void edges.refetch()} />
      ) : !list ? (
        <p role="status" className="text-muted">
          {RELATIONSHIPS_COPY.loading}
        </p>
      ) : list.length === 0 ? (
        <p className="text-muted">{RELATIONSHIPS_COPY.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((edge, index) => (
            <RelationshipItem
              key={edge.id}
              itemRef={(element) => {
                if (element) items.current.set(edge.id, element);
                else items.current.delete(edge.id);
              }}
              studyId={studyId}
              edge={edge}
              nodeId={node.id}
              sentence={sentence}
              otherLabel={labelOf(otherEnd(edge, node.id))}
              editable={editable}
              onShow={() => onShowNode(otherEnd(edge, node.id))}
              onSaved={(cleared) => {
                void refresh(edge, cleared);
                setAnnouncement(said(RELATIONSHIPS_COPY.saved, cleared));
              }}
              onRemoved={(cleared) => {
                focusAt.current = index;
                void refresh(edge, cleared);
                setAnnouncement(said(RELATIONSHIPS_COPY.removed, cleared));
              }}
              onLocked={onLocked}
              refetch={() => edges.refetch()}
            />
          ))}
        </ul>
      )}
      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            ref={connectButton}
            aria-haspopup="dialog"
            disabled={!hasOther}
            aria-describedby={hasOther ? undefined : noOtherId}
            onClick={() => {
              setAnnouncement('');
              setConnecting(true);
            }}
            className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
          >
            Connect
          </button>
          {hasOther ? null : (
            <p id={noOtherId} className="text-sm">
              {CONNECT_COPY.noOther}
            </p>
          )}
        </div>
      ) : null}
      {editable && connecting ? (
        <ConnectDialog
          studyId={studyId}
          studyRevision={studyRevision}
          nodes={nodes}
          prefill={{ fromId: node.id, toId: null }}
          onClose={connectClosed}
        />
      ) : null}
      {editable && evidenceConnect ? (
        <ConnectDialog
          studyId={studyId}
          studyRevision={studyRevision}
          nodes={nodes}
          prefill={evidenceConnect}
          onClose={(outcome) => {
            if (outcome === 'locked') onLocked();
            if (outcome === 'created') setAnnouncement(CONNECT_COPY.added);
            onEvidenceConnectClosed?.(outcome);
          }}
        />
      ) : null}
    </section>
  );
}

/** Escape closes an inline form (its opener takes focus back). */
const closeOnEscape = (close: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
};

type ItemMode = 'view' | 'edit' | 'remove';

function RelationshipItem({
  itemRef,
  studyId,
  edge,
  nodeId,
  sentence,
  otherLabel,
  editable,
  onShow,
  onSaved,
  onRemoved,
  onLocked,
  refetch,
}: {
  itemRef: (element: HTMLLIElement | null) => void;
  studyId: string;
  edge: Edge;
  nodeId: string;
  sentence: (type: EdgeType, otherId: string, reversed: boolean) => string;
  otherLabel: string;
  editable: boolean;
  onShow: () => void;
  onSaved: (clearedNodeIds: string[]) => void;
  onRemoved: (clearedNodeIds: string[]) => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<ItemMode>('view');
  const editButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<'edit' | 'remove' | null>(null);
  const otherId = otherEnd(edge, nodeId);
  const reversed = edge.targetNodeId === nodeId && !isSymmetricEdgeType(edge.type);

  useEffect(() => {
    if (mode !== 'view' || !returnTo.current) return;
    (returnTo.current === 'edit' ? editButton : removeButton).current?.focus();
    returnTo.current = null;
  }, [mode]);

  const close = (from: 'edit' | 'remove') => {
    returnTo.current = from;
    setMode('view');
  };

  return (
    <li ref={itemRef} tabIndex={-1} className="flex flex-col gap-2 rounded border border-muted p-3">
      <p className="break-words">{sentence(edge.type, otherId, reversed)}</p>
      <p className="text-sm text-muted">
        {EDGE_TYPE_NAMES[edge.type]} · Added by {ORIGIN_NAMES[edge.origin]}
      </p>
      {edge.note ? (
        <p className="break-words whitespace-pre-wrap">
          <span className="font-medium">Note: </span>
          {edge.note}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onShow} className="underline">
          Show <span className="sr-only">{otherLabel}</span>
        </button>
        {editable && mode === 'view' ? (
          <>
            <button
              type="button"
              ref={editButton}
              onClick={() => setMode('edit')}
              className="rounded border border-accent px-3 py-1 text-accent"
            >
              Edit <span className="sr-only">relationship with {otherLabel}</span>
            </button>
            <button
              type="button"
              ref={removeButton}
              onClick={() => setMode('remove')}
              className="rounded border border-muted px-3 py-1"
            >
              Remove <span className="sr-only">relationship with {otherLabel}</span>
            </button>
          </>
        ) : null}
      </div>
      {editable && mode === 'edit' ? (
        <EditRelationship
          studyId={studyId}
          edge={edge}
          otherId={otherId}
          reversed={reversed}
          sentence={sentence}
          onSaved={(cleared) => {
            close('edit');
            onSaved(cleared);
          }}
          onCancel={() => close('edit')}
          onLocked={onLocked}
          refetch={refetch}
        />
      ) : null}
      {editable && mode === 'remove' ? (
        <RemoveRelationship
          studyId={studyId}
          edge={edge}
          onRemoved={onRemoved}
          onCancel={() => close('remove')}
          onLocked={onLocked}
          refetch={refetch}
        />
      ) : null}
    </li>
  );
}

function EditRelationship({
  studyId,
  edge,
  otherId,
  reversed,
  sentence,
  onSaved,
  onCancel,
  onLocked,
  refetch,
}: {
  studyId: string;
  edge: Edge;
  otherId: string;
  reversed: boolean;
  sentence: (type: EdgeType, otherId: string, reversed: boolean) => string;
  onSaved: (clearedNodeIds: string[]) => void;
  onCancel: () => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
}) {
  const first = useRef<HTMLSelectElement>(null);
  const [base, setBase] = useState(edge);
  const [type, setType] = useState<EdgeType>(edge.type);
  const [note, setNote] = useState(edge.note ?? '');
  const [typeError, setTypeError] = useState<string | undefined>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const request = useFrozenRequest((body: UpdateEdgeRequest, key: string) =>
    updateEdge(studyId, edge.id, body, key),
  );

  useEffect(() => {
    first.current?.focus();
  }, []);

  async function save(retry = false) {
    const attempt = retry
      ? request.retry()
      : request.send({ expectedRevision: base.revision, type, note: note.trim() ? note : null });
    if (!attempt) return;
    setProblem(null);
    setTypeError(undefined);
    const result = await attempt;
    if (result.ok) {
      onSaved(result.value.establishmentClearedNodeIds);
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: RELATIONSHIPS_COPY.unknownSave, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (codeOf(error) === EDGE_UNCHANGED) onSaved([]);
    else if (statusOf(error) === 409)
      setProblem({ text: RELATIONSHIPS_COPY.editConflict, reload: true });
    else if (statusOf(error) === 404) {
      void refetch();
      setProblem({ text: RELATIONSHIPS_COPY.alreadyRemoved });
    } else if (codeOf(error) === EDGE_EXISTS) setTypeError(EDGE_RULE_COPY.exists);
    else if (codeOf(error) === EDGE_TARGET_NOT_QUESTION) {
      setTypeError(EDGE_RULE_COPY.targetNotQuestion);
    } else setProblem({ text: RELATIONSHIPS_COPY.failedSave });
  }

  /** After a 409: replace the draft with the saved version, only once the user confirms. */
  async function reload() {
    if (!window.confirm(RELATIONSHIPS_COPY.reloadConfirm)) return;
    const fresh = (await refetch()) as { data?: { items: Edge[] } };
    const latest = fresh.data?.items.find((item) => item.id === edge.id);
    if (!latest) {
      setProblem({ text: RELATIONSHIPS_COPY.alreadyRemoved });
      return;
    }
    setBase(latest);
    setType(latest.type);
    setNote(latest.note ?? '');
    setProblem(null);
  }

  return (
    <form
      noValidate
      aria-label="Edit relationship"
      className="flex flex-col gap-3"
      onKeyDown={closeOnEscape(onCancel)}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TypeSelect
        value={type}
        onChange={(value) => {
          // No placeholder here: a type is always chosen.
          if (value) setType(value);
          setTypeError(undefined);
        }}
        types={sameDirectionClassTypes(edge.type)}
        error={typeError}
        selectRef={first}
      />
      <p aria-live="polite" className="break-words">
        {sentence(type, otherId, reversed)}
      </p>
      <TextAreaField
        label="Note (optional)"
        value={note}
        onChange={setNote}
        max={MAX_EDGE_NOTE_LENGTH}
        rows={3}
      />
      {problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() => void save(true)}
          onReload={() => void reload()}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          aria-disabled={request.pending ? true : undefined}
          onClick={(event) => {
            if (request.pending) event.preventDefault();
          }}
          className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
        >
          {request.pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RemoveRelationship({
  studyId,
  edge,
  onRemoved,
  onCancel,
  onLocked,
  refetch,
}: {
  studyId: string;
  edge: Edge;
  onRemoved: (clearedNodeIds: string[]) => void;
  onCancel: () => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
}) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const request = useFrozenRequest((body: { expectedRevision: number }, key: string) =>
    deleteEdge(studyId, edge.id, body, key),
  );

  useEffect(() => {
    confirmButton.current?.focus();
  }, []);

  async function remove(retry = false) {
    const attempt = retry ? request.retry() : request.send({ expectedRevision: edge.revision });
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok) {
      onRemoved(result.value.establishmentClearedNodeIds);
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: RELATIONSHIPS_COPY.unknownRemove, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (statusOf(error) === 409) {
      setProblem({ text: RELATIONSHIPS_COPY.removeConflict, reload: true });
    } else if (statusOf(error) === 404) {
      void refetch();
      setProblem({ text: RELATIONSHIPS_COPY.alreadyRemoved });
    } else setProblem({ text: RELATIONSHIPS_COPY.failedRemove });
  }

  return (
    <div
      role="group"
      aria-label="Remove relationship"
      className="flex flex-col gap-2"
      onKeyDown={closeOnEscape(onCancel)}
    >
      <p>{RELATIONSHIPS_COPY.removeConfirm}</p>
      {problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() => void remove(true)}
          onReload={() => {
            void refetch();
            onCancel();
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          ref={confirmButton}
          aria-disabled={request.pending ? true : undefined}
          onClick={() => void remove()}
          className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
        >
          {request.pending ? 'Removing…' : 'Remove'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
}
