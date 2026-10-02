'use client';

import {
  type CreateEdgeRequest,
  type CreateEdgeResponse,
  DEFAULT_EDGE_TYPES,
  EDGE_EXISTS,
  EDGE_LIMIT_EXCEEDED,
  EDGE_TARGET_NOT_QUESTION,
  EDGE_TYPE_HELP,
  EDGE_TYPE_NAMES,
  EDGE_TYPES,
  EDGE_UNCHANGED,
  type Edge,
  type EdgeOrigin,
  type EdgeType,
  isSymmetricEdgeType,
  MAX_EDGE_NOTE_LENGTH,
  type NodeSummary,
  sameDirectionClassTypes,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  type StudyNodeType,
  type StudyResponse,
  type UpdateEdgeRequest,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type Ref, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { ApiError } from '@/lib/api-client';
import { classifyError, isRetryable } from '@/lib/api-errors';
import {
  createEdge,
  deleteEdge,
  edgeSentence,
  edgesQueryKey,
  listEdges,
  otherEnd,
  thisNode,
  updateEdge,
} from '@/lib/edges';
import { nodeOptionText, nodesQueryKey } from '@/lib/nodes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { TextAreaField } from './node-fields';

export const RELATIONSHIPS_COPY = {
  loading: 'Loading relationships…',
  empty: 'No relationships yet.',
  noOther: 'Add another node first.',
  added: 'Relationship added.',
  existing:
    "These nodes already have this relationship. Your note wasn't added; edit the relationship to change its note.",
  conflict:
    'The study changed somewhere else, so the relationship was not added. Press Connect again.',
  gone: 'That node is no longer in this study.',
  limit: 'This study holds the most relationships it can (6,000), so this one was not added.',
  targetNotQuestion: 'This relationship must point to a question.',
  exists: 'These nodes already have a relationship of that type.',
  unknownAdd: "Couldn't confirm the relationship was added. Retry won't add it twice.",
  failedAdd: "Couldn't add the relationship.",
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
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "This node's relationships aren't available.",
  refused: "Couldn't load the relationships.",
  unavailable: "Couldn't load the relationships.",
};

const ORIGIN_NAMES: Record<EdgeOrigin, string> = { user: 'You', ai: 'AI suggestion you accepted' };

const MORE_EDGE_TYPES = EDGE_TYPES.filter(
  (type) => !(DEFAULT_EDGE_TYPES as readonly EdgeType[]).includes(type),
);

type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown; unknown: boolean };

/**
 * One mutation's request lifecycle (PRD section 24 idempotency), as `useAddNode` does for nodes:
 * `send` freezes that exact body with a new Idempotency-Key (unless the same body still awaits its
 * outcome); `retry` resends the frozen request verbatim after an unknown outcome (network, 5xx,
 * 429, a retryable refusal); a known outcome clears it. Both return null while one is in flight.
 */
function useFrozenRequest<B, R>(run: (body: B, key: string) => Promise<R>) {
  const frozen = useRef<{ json: string; key: string; body: B } | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  async function go(attempt: { json: string; key: string; body: B }): Promise<Outcome<R>> {
    inFlight.current = true;
    setPending(true);
    try {
      const value = await run(attempt.body, attempt.key);
      frozen.current = null;
      return { ok: true, value };
    } catch (error) {
      const unknown = !(error instanceof ApiError) || isRetryable(classifyError(error));
      if (!unknown) frozen.current = null;
      return { ok: false, error, unknown };
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    send(body: B): Promise<Outcome<R>> | null {
      if (inFlight.current) return null;
      const json = JSON.stringify(body);
      const attempt =
        frozen.current?.json === json ? frozen.current : { json, key: crypto.randomUUID(), body };
      frozen.current = attempt;
      return go(attempt);
    },
    retry(): Promise<Outcome<R>> | null {
      if (inFlight.current || frozen.current === null) return null;
      return go(frozen.current);
    },
  };
}

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
const isLifecycle = (error: unknown) =>
  codeOf(error) === STUDY_ARCHIVED || codeOf(error) === STUDY_TRASHED;

interface Problem {
  text: string;
  retry?: boolean;
  reload?: boolean;
}

/**
 * The open node's relationships (BIB-27, PRD section 12): each one a sentence from this node's
 * side whose verb states the direction ("This observation supports Conclusion: …", "Romans 8:16
 * supports this observation"), never an arrow or color alone. An active study can connect this
 * node to another (inline form with a live direction preview and Swap direction), change a
 * relationship's type (same direction class) or note, and remove one. Everything is native buttons
 * and selects; no drag. BIB-29 replaces this with the study-wide List View and Connect dialog.
 */
export function Relationships({
  studyId,
  node,
  nodes,
  studyRevision,
  editable,
  onLocked,
  onReload,
  onShowNode,
}: {
  studyId: string;
  node: { id: string; type: StudyNodeType };
  /** The study's live nodes (the Nodes list), for labels and the "Other node" choice. */
  nodes: NodeSummary[];
  studyRevision: number;
  editable: boolean;
  onLocked: () => void;
  /** Re-reads the study (after a 409 on connect, which is against the study's revision). */
  onReload: () => Promise<unknown>;
  onShowNode: (nodeId: string) => void;
}) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState('');
  const [connecting, setConnecting] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const returnToConnect = useRef(false);
  const items = useRef(new Map<string, HTMLLIElement>());
  /** After a removal: the list position whose item (or else Connect) takes focus. */
  const focusAt = useRef<number | null>(null);
  const edges = useQuery({
    queryKey: edgesQueryKey(studyId, node.id),
    queryFn: () => listEdges(studyId, node.id),
  });
  const list = edges.data?.items;

  useEffect(() => {
    if (connecting || !returnToConnect.current) return;
    returnToConnect.current = false;
    connectButton.current?.focus();
  }, [connecting]);

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

  /** After any edge change: both endpoints' lists, the study's counters, the library order. */
  async function refresh(edge: Pick<Edge, 'sourceNodeId' | 'targetNodeId'>) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: edgesQueryKey(studyId, edge.sourceNodeId) }),
      queryClient.invalidateQueries({ queryKey: edgesQueryKey(studyId, edge.targetNodeId) }),
      queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId), exact: true }),
      invalidateLibrary(queryClient),
    ]);
  }

  /** Adopts the study revision the server returned and refetches both endpoints' lists. */
  function adopt(edge: CreateEdgeResponse) {
    queryClient.setQueryData<StudyResponse>(studyQueryKey(studyId), (old) =>
      old && edge.studyRevision > old.revision ? { ...old, revision: edge.studyRevision } : old,
    );
    void refresh(edge);
  }

  function connected(edge: CreateEdgeResponse) {
    adopt(edge);
    returnToConnect.current = true;
    setConnecting(false);
    setAnnouncement(RELATIONSHIPS_COPY.added);
  }

  const others = nodes.filter((candidate) => candidate.id !== node.id);

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
              onSaved={() => {
                void refresh(edge);
                setAnnouncement(RELATIONSHIPS_COPY.saved);
              }}
              onRemoved={() => {
                focusAt.current = index;
                void refresh(edge);
                setAnnouncement(RELATIONSHIPS_COPY.removed);
              }}
              onLocked={onLocked}
              refetch={() => edges.refetch()}
            />
          ))}
        </ul>
      )}
      {editable && !connecting ? (
        <div>
          <button
            type="button"
            ref={connectButton}
            onClick={() => {
              setAnnouncement('');
              setConnecting(true);
            }}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Connect
          </button>
        </div>
      ) : null}
      {editable && connecting ? (
        <ConnectForm
          studyId={studyId}
          nodeId={node.id}
          others={others}
          studyRevision={studyRevision}
          sentence={sentence}
          onConnected={connected}
          onExisting={adopt}
          onCancel={() => {
            returnToConnect.current = true;
            setConnecting(false);
          }}
          onLocked={onLocked}
          onReload={onReload}
          onNodeGone={() =>
            void queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) })
          }
        />
      ) : null}
    </section>
  );
}

function TypeOptions({ types }: { types: readonly EdgeType[] }) {
  return types.map((type) => (
    <option key={type} value={type}>
      {EDGE_TYPE_NAMES[type]}
    </option>
  ));
}

/** The relationship picker: the default types, then "More relationships", with helper copy. */
function TypeSelect({
  value,
  onChange,
  types,
  error,
  selectRef,
}: {
  value: EdgeType;
  onChange: (type: EdgeType) => void;
  /** Only these (an edit offers its own direction class); all 15 when omitted. */
  types?: readonly EdgeType[];
  error?: string;
  selectRef?: Ref<HTMLSelectElement>;
}) {
  const id = useId();
  const help = EDGE_TYPE_HELP[value];
  const described = [help ? `${id}-help` : '', error ? `${id}-error` : ''].join(' ').trim();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        Relationship
      </label>
      <select
        id={id}
        ref={selectRef}
        value={value}
        onChange={(event) => onChange(event.target.value as EdgeType)}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        className="w-full rounded border border-muted bg-canvas px-2 py-1"
      >
        {types ? (
          <TypeOptions types={types} />
        ) : (
          <>
            <TypeOptions types={DEFAULT_EDGE_TYPES} />
            <optgroup label="More relationships">
              <TypeOptions types={MORE_EDGE_TYPES} />
            </optgroup>
          </>
        )}
      </select>
      {help ? (
        <p id={`${id}-help`} className="text-sm text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProblemLine({
  problem,
  onRetry,
  onReload,
}: {
  problem: Problem;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p>{problem.text}</p>
      {problem.retry && onRetry ? (
        <button type="button" onClick={onRetry} className="underline">
          Retry
        </button>
      ) : null}
      {problem.reload && onReload ? (
        <button type="button" onClick={onReload} className="underline">
          Reload
        </button>
      ) : null}
    </div>
  );
}

/** Escape closes an inline form (its opener takes focus back). */
const closeOnEscape = (close: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
};

function ConnectForm({
  studyId,
  nodeId,
  others,
  studyRevision,
  sentence,
  onConnected,
  onExisting,
  onCancel,
  onLocked,
  onReload,
  onNodeGone,
}: {
  studyId: string;
  nodeId: string;
  others: NodeSummary[];
  studyRevision: number;
  sentence: (type: EdgeType, otherId: string, reversed: boolean) => string;
  onConnected: (edge: CreateEdgeResponse) => void;
  /** The relationship already existed (perhaps made in another tab): sync lists and revision. */
  onExisting: (edge: CreateEdgeResponse) => void;
  onCancel: () => void;
  onLocked: () => void;
  onReload: () => Promise<unknown>;
  onNodeGone: () => void;
}) {
  const otherId = useId();
  const previewId = useId();
  const first = useRef<HTMLSelectElement>(null);
  const [type, setType] = useState<EdgeType>(DEFAULT_EDGE_TYPES[0]);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const [swapped, setSwapped] = useState(false);
  const [note, setNote] = useState('');
  const [typeError, setTypeError] = useState<string | undefined>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [existing, setExisting] = useState(false);
  const request = useFrozenRequest((body: CreateEdgeRequest, key: string) =>
    createEdge(studyId, body, key),
  );

  useEffect(() => {
    first.current?.focus();
  }, []);

  const twoWay = isSymmetricEdgeType(type);
  const reversed = swapped && !twoWay;
  // If the picked node left the list, the select shows the first option: send what is shown.
  const chosen = others.some((candidate) => candidate.id === other) ? other : (others[0]?.id ?? '');

  async function submit(retry = false) {
    let attempt;
    if (retry) attempt = request.retry();
    else {
      if (!chosen) return;
      attempt = request.send({
        expectedRevision: studyRevision,
        sourceNodeId: reversed ? chosen : nodeId,
        targetNodeId: reversed ? nodeId : chosen,
        type,
        ...(note.trim() ? { note } : {}),
      });
    }
    if (!attempt) return;
    setProblem(null);
    setExisting(false);
    setTypeError(undefined);
    const result = await attempt;
    if (result.ok) {
      if (result.value.outcome === 'created') onConnected(result.value);
      else {
        onExisting(result.value);
        setExisting(true);
      }
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: RELATIONSHIPS_COPY.unknownAdd, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (statusOf(error) === 409) {
      void onReload();
      setProblem({ text: RELATIONSHIPS_COPY.conflict });
    } else if (statusOf(error) === 404) {
      onNodeGone();
      setProblem({ text: RELATIONSHIPS_COPY.gone });
    } else if (codeOf(error) === EDGE_TARGET_NOT_QUESTION) {
      setTypeError(RELATIONSHIPS_COPY.targetNotQuestion);
    } else if (codeOf(error) === EDGE_LIMIT_EXCEEDED) {
      setProblem({ text: RELATIONSHIPS_COPY.limit });
    } else setProblem({ text: RELATIONSHIPS_COPY.failedAdd });
  }

  if (others.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3" onKeyDown={closeOnEscape(onCancel)}>
        <p>{RELATIONSHIPS_COPY.noOther}</p>
        <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      aria-label="Connect this node"
      className="flex flex-col gap-3"
      onKeyDown={closeOnEscape(onCancel)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TypeSelect
        value={type}
        onChange={(value) => {
          setType(value);
          setTypeError(undefined);
        }}
        error={typeError}
        selectRef={first}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={otherId} className="font-medium">
          Other node
        </label>
        <select
          id={otherId}
          value={chosen}
          onChange={(event) => setOther(event.target.value)}
          className="w-full rounded border border-muted bg-canvas px-2 py-1"
        >
          {others.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {nodeOptionText(candidate)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Direction</p>
        <p id={previewId} aria-live="polite" className="break-words">
          {chosen ? sentence(type, chosen, reversed) : ''}
        </p>
        {twoWay ? null : (
          <div>
            <button
              type="button"
              aria-describedby={previewId}
              onClick={() => setSwapped(!swapped)}
              className="rounded border border-muted px-3 py-1"
            >
              Swap direction
            </button>
          </div>
        )}
      </div>
      <TextAreaField
        label="Note (optional)"
        value={note}
        onChange={setNote}
        max={MAX_EDGE_NOTE_LENGTH}
        rows={3}
      />
      {existing ? <p role="status">{RELATIONSHIPS_COPY.existing}</p> : null}
      {problem ? <ProblemLine problem={problem} onRetry={() => void submit(true)} /> : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          aria-disabled={request.pending ? true : undefined}
          onClick={(event) => {
            if (request.pending) event.preventDefault();
          }}
          className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
        >
          {request.pending ? 'Connecting…' : 'Connect'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  onSaved: () => void;
  onRemoved: () => void;
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
          onSaved={() => {
            close('edit');
            onSaved();
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
  onSaved: () => void;
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
      onSaved();
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: RELATIONSHIPS_COPY.unknownSave, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (codeOf(error) === EDGE_UNCHANGED) onSaved();
    else if (statusOf(error) === 409)
      setProblem({ text: RELATIONSHIPS_COPY.editConflict, reload: true });
    else if (statusOf(error) === 404) {
      void refetch();
      setProblem({ text: RELATIONSHIPS_COPY.alreadyRemoved });
    } else if (codeOf(error) === EDGE_EXISTS) setTypeError(RELATIONSHIPS_COPY.exists);
    else if (codeOf(error) === EDGE_TARGET_NOT_QUESTION) {
      setTypeError(RELATIONSHIPS_COPY.targetNotQuestion);
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
          setType(value);
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
  onRemoved: () => void;
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
      onRemoved();
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
