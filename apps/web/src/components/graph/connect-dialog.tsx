'use client';

import {
  type CreateEdgeRequest,
  type CreateEdgeResponse,
  EDGE_EXISTS,
  EDGE_LIMIT_EXCEEDED,
  EDGE_TARGET_NOT_QUESTION,
  type EdgeType,
  isSymmetricEdgeType,
  MAX_EDGE_NOTE_LENGTH,
  type NodeSummary,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type Ref, useEffect, useId, useRef, useState } from 'react';
import { TextAreaField } from '@/components/nodes/node-fields';
import {
  codeOf,
  EDGE_RULE_COPY,
  isLifecycle,
  type Problem,
  ProblemLine,
  statusOf,
  TypeSelect,
  useFrozenRequest,
} from '@/components/nodes/relationship-controls';
import { createEdge, edgeSentence, invalidateEdgeChange } from '@/lib/edges';
import { invalidateGraph } from '@/lib/graph';
import { nodeOptionText, nodesQueryKey } from '@/lib/nodes';
import { studyQueryKey } from '@/lib/studies';

export const CONNECT_COPY = {
  title: 'Connect nodes',
  chooseNode: 'Choose a node',
  chooseType: 'Choose a relationship',
  needFrom: 'Choose the node the relationship starts from.',
  needType: 'Choose a relationship.',
  needTo: 'Choose the node the relationship points to.',
  sameNode: 'Choose two different nodes.',
  noOther: 'Add another node first.',
  added: 'Relationship added.',
  existing:
    "These nodes already have this relationship. Your note wasn't added; edit the relationship to change its note.",
  conflict:
    'The study changed somewhere else, so the relationship was not added. Press Connect again.',
  gone: 'That node is no longer in this study.',
  limit: 'This study holds the most relationships it can (6,000), so this one was not added.',
  unknownAdd: "Couldn't confirm the relationship was added. Retry won't add it twice.",
  failedAdd: "Couldn't add the relationship.",
} as const;

/** What an opener fills in. The relationship type is never prefilled: the user always picks it. */
export interface ConnectPrefill {
  fromId: string | null;
  toId: string | null;
}

/** How the dialog closed: after the server's 201, by Cancel or Escape, or after a lifecycle refusal. */
export type ConnectOutcome = 'created' | 'cancelled' | 'locked';

interface FieldErrors {
  from?: string;
  type?: string;
  to?: string;
}

/**
 * The one Connect UI (BIB-29, FR-GRAPH-013), a native modal dialog opened from the graph toolbar,
 * a List View row, node detail's Relationships or a canvas handle drop. Openers only prefill the
 * endpoints; From, the relationship type, To and the direction (Swap direction) are all native
 * controls, with a live sentence preview. Nothing is sent until Connect: one frozen
 * `POST /edges` on the study's revision with its Idempotency-Key, resent verbatim by Retry after
 * an unknown outcome (BIB-27). It closes only after the server's 201, on Cancel or Escape (never
 * while a request is pending), or on a lifecycle refusal; the caller then returns focus (to its
 * opener, or its locked alert) and announces "Relationship added.".
 *
 * Mounted while open: each opening starts a fresh draft.
 */
export function ConnectDialog({
  studyId,
  studyRevision,
  nodes,
  prefill,
  onClose,
}: {
  studyId: string;
  studyRevision: number;
  /** Every live node of the study, in snapshot order: the endpoint choices. */
  nodes: readonly NodeSummary[];
  prefill: ConnectPrefill;
  onClose: (outcome: ConnectOutcome) => void;
}) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const previewId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fromRef = useRef<HTMLSelectElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const toRef = useRef<HTMLSelectElement>(null);
  const [fromId, setFromId] = useState(prefill.fromId ?? '');
  const [toId, setToId] = useState(prefill.toId ?? '');
  const [type, setType] = useState<EdgeType | ''>('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [existing, setExisting] = useState(false);
  const request = useFrozenRequest((body: CreateEdgeRequest, key: string) =>
    createEdge(studyId, body, key),
  );

  // A node that left the study (deleted elsewhere, a 404) is no longer chosen: its field clears.
  const live = (id: string) => nodes.some((node) => node.id === id);
  const from = live(fromId) ? fromId : '';
  const to = live(toId) ? toId : '';
  const nameOf = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node ? nodeOptionText(node) : '';
  };
  const twoWay = type !== '' && isSymmetricEdgeType(type);

  // Opens modally with focus on the first field still to fill (From, then Relationship, which is
  // never prefilled).
  const prefilledFrom = useRef(from !== '');
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    (prefilledFrom.current ? typeRef : fromRef).current?.focus();
  }, []);

  function close(outcome: ConnectOutcome) {
    // Closed first, so the page outside is no longer inert when the caller moves focus there.
    dialogRef.current?.close();
    onClose(outcome);
  }

  function cancel() {
    // A pending request's result is never orphaned: Cancel and Escape wait for it.
    if (!request.pending) close('cancelled');
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Escape belongs to the dialog: the graph around it would otherwise clear its selection.
    event.stopPropagation();
    cancel();
  }

  /** Every outcome moved (or confirmed) the study's revision: adopt it and refresh both ends. */
  function adopt(edge: CreateEdgeResponse) {
    queryClient.setQueryData<StudyResponse>(studyQueryKey(studyId), (old) =>
      old && edge.studyRevision > old.revision ? { ...old, revision: edge.studyRevision } : old,
    );
    void invalidateEdgeChange(queryClient, studyId, edge);
  }

  async function submit(retry = false) {
    let attempt;
    if (retry) attempt = request.retry();
    else {
      const missing: FieldErrors = {
        ...(from ? {} : { from: CONNECT_COPY.needFrom }),
        ...(type ? {} : { type: CONNECT_COPY.needType }),
        ...(!to ? { to: CONNECT_COPY.needTo } : to === from ? { to: CONNECT_COPY.sameNode } : {}),
      };
      setErrors(missing);
      if (missing.from || missing.type || missing.to || !type) {
        (missing.from ? fromRef : missing.type ? typeRef : toRef).current?.focus();
        return;
      }
      attempt = request.send({
        expectedRevision: studyRevision,
        sourceNodeId: from,
        targetNodeId: to,
        type,
        ...(note.trim() ? { note } : {}),
      });
    }
    if (!attempt) return;
    setProblem(null);
    setExisting(false);
    const result = await attempt;
    if (result.ok) {
      adopt(result.value);
      if (result.value.outcome === 'created') close('created');
      else setExisting(true);
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: CONNECT_COPY.unknownAdd, retry: true });
    else if (isLifecycle(error)) close('locked');
    else if (statusOf(error) === 409) {
      // Against the study's revision: re-read it, and the next Connect is a new request.
      void queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId), exact: true });
      setProblem({ text: CONNECT_COPY.conflict });
    } else if (statusOf(error) === 404) {
      void invalidateGraph(queryClient, studyId);
      void queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) });
      setProblem({ text: CONNECT_COPY.gone });
    } else if (codeOf(error) === EDGE_TARGET_NOT_QUESTION) {
      setErrors({ type: EDGE_RULE_COPY.targetNotQuestion });
    } else if (codeOf(error) === EDGE_EXISTS) {
      setErrors({ type: EDGE_RULE_COPY.exists });
    } else if (codeOf(error) === EDGE_LIMIT_EXCEEDED) {
      setProblem({ text: CONNECT_COPY.limit });
    } else setProblem({ text: CONNECT_COPY.failedAdd });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded border border-muted bg-canvas p-6 text-ink backdrop:bg-black/40"
    >
      <h2 id={titleId} className="font-serif text-2xl">
        {CONNECT_COPY.title}
      </h2>
      {nodes.length < 2 ? (
        <div className="mt-4 flex flex-col gap-3">
          <p>{CONNECT_COPY.noOther}</p>
          <div>
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-muted px-3 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          aria-labelledby={titleId}
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <NodeSelect
            label="From"
            value={from}
            nodes={nodes.filter((node) => node.id !== to)}
            error={errors.from}
            selectRef={fromRef}
            onChange={(id) => {
              setFromId(id);
              setErrors((old) => ({ ...old, from: undefined }));
            }}
          />
          <TypeSelect
            value={type}
            placeholder={CONNECT_COPY.chooseType}
            error={errors.type}
            selectRef={typeRef}
            onChange={(value) => {
              setType(value);
              setErrors((old) => ({ ...old, type: undefined }));
            }}
          />
          <NodeSelect
            label="To"
            value={to}
            nodes={nodes.filter((node) => node.id !== from)}
            error={errors.to}
            selectRef={toRef}
            onChange={(id) => {
              setToId(id);
              setErrors((old) => ({ ...old, to: undefined }));
            }}
          />
          {twoWay ? null : (
            <div>
              <button
                type="button"
                aria-describedby={previewId}
                onClick={() => {
                  setFromId(to);
                  setToId(from);
                }}
                className="rounded border border-muted px-3 py-1"
              >
                Swap direction
              </button>
            </div>
          )}
          <p id={previewId} aria-live="polite" className="break-words">
            {from && to && type ? edgeSentence(nameOf(from), type, nameOf(to)) : ''}
          </p>
          <TextAreaField
            label="Note (optional)"
            value={note}
            onChange={setNote}
            max={MAX_EDGE_NOTE_LENGTH}
            rows={3}
          />
          {existing ? <p role="status">{CONNECT_COPY.existing}</p> : null}
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
            <button
              type="button"
              aria-disabled={request.pending ? true : undefined}
              onClick={cancel}
              className="rounded border border-muted px-3 py-1 aria-disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** An endpoint picker: "Choose a node", then the study's nodes as the Notes select names them. */
function NodeSelect({
  label,
  value,
  nodes,
  error,
  selectRef,
  onChange,
}: {
  label: string;
  value: string;
  nodes: readonly NodeSummary[];
  error?: string;
  selectRef: Ref<HTMLSelectElement>;
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <select
        id={id}
        ref={selectRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-full rounded border border-muted bg-canvas px-2 py-1"
      >
        <option value="">{CONNECT_COPY.chooseNode}</option>
        {nodes.map((node) => (
          <option key={node.id} value={node.id}>
            {nodeOptionText(node)}
          </option>
        ))}
      </select>
      {error ? (
        <p id={`${id}-error`} className="text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}
