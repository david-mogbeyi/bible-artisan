'use client';

import {
  CONCLUSION_EVIDENCE_REQUIRED,
  CONCLUSION_NOT_SUPPORTED,
  type ConclusionStatus,
  MAX_CHANGE_REASON_LENGTH,
  MAX_QUESTION_LENGTH,
  NODE_STATUS_NAMES,
  NODE_TYPE_NAMES,
  NODE_UNCHANGED,
  type NodeResponse,
  type NodeVersion,
  QUESTION_STATUSES,
  type QuestionStatus,
  type UpdateNodeRequest,
  updateNodeRequestSchema,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { sentenceFrom } from '@/lib/edges';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import {
  ESTABLISHED_TEXT,
  fetchNodeVersions,
  formatNodeTime,
  invalidateNodeChange,
  nodeVersionsQueryKey,
  updateNode,
} from '@/lib/nodes';
import { type FieldErrors, fieldErrorsOf, TextAreaField } from './node-fields';
import {
  codeOf,
  isLifecycle,
  type Problem,
  ProblemLine,
  statusOf,
  useFrozenRequest,
} from './relationship-controls';

export const CONCLUSION_COPY = {
  establishedHelp: 'You marked this as established in this study. It is not a universal claim.',
  incomplete:
    'Evidence incomplete: this conclusion is marked Supported but no live evidence supports it. Connect evidence or change its status.',
  evidenceRequired:
    'Connect supporting evidence first: a relationship that supports this conclusion, or one this conclusion is inferred from.',
  evidenceHelp:
    'Evidence is a relationship that supports this conclusion, or one this conclusion is inferred from.',
  notSupported: 'Only a supported conclusion can be marked established.',
  reviseHelp:
    'Revising saves a new version and sets the status to Revised. Earlier versions stay in History.',
  clearsMarker: "This clears 'Established by me'.",
  conflict: 'This node changed somewhere else, so your change was not saved.',
  unknown: "Couldn't confirm the change was saved. Retry won't save it twice.",
  unchanged: 'No changes to save.',
  failed: "Couldn't save the change.",
  reloadConfirm: 'Replace your draft with the version saved elsewhere?',
  saved: 'Saved',
  savedCleared: "Saved. 'Established by me' was cleared.",
  historyLoading: 'Loading history…',
  historyEmpty: 'No earlier versions.',
  evidenceRemoved: 'Established by me cleared: its last supporting evidence was removed.',
} as const;

const HISTORY_COPY: ProblemCopy = {
  notFound: "This conclusion's history isn't available.",
  refused: "Couldn't load the history.",
  unavailable: "Couldn't load the history.",
};

type Conclusion = Extract<NodeResponse, { type: 'conclusion' }>;
type Question = Extract<NodeResponse, { type: 'question' }>;

/** The statuses a user can choose; Revised is only ever the result of a new statement. */
const CHOOSABLE: readonly ConclusionStatus[] = [
  'tentative',
  'supported',
  'challenged',
  'abandoned',
];

/** Everything a successful action refreshes: the node, its history, lists, the study counters. */
async function refreshAfter(
  queryClient: ReturnType<typeof useQueryClient>,
  studyId: string,
  nodeId: string,
) {
  await Promise.all([
    invalidateNodeChange(queryClient, studyId, nodeId),
    queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId), exact: true }),
    invalidateLibrary(queryClient),
  ]);
}

/** A radio group of statuses with their text names. */
function StatusRadios<S extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  describedBy,
}: {
  legend: string;
  name: string;
  options: readonly S[];
  value: S | null;
  onChange: (status: S) => void;
  describedBy?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={describedBy}>
      <legend className="font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        {options.map((status) => (
          <label key={status} className="flex items-center gap-2">
            <input
              type="radio"
              name={name}
              value={status}
              checked={value === status}
              onChange={() => onChange(status)}
            />
            {NODE_STATUS_NAMES[status as keyof typeof NODE_STATUS_NAMES]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SaveCancel({
  pending,
  onCancel,
  saveLabel = 'Save',
}: {
  pending: boolean;
  onCancel: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        aria-disabled={pending ? true : undefined}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
      >
        {pending ? 'Saving…' : saveLabel}
      </button>
      <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
        Cancel
      </button>
    </div>
  );
}

/**
 * A Question's status (BIB-30; FR-QUESTION-001/002): the current status as text and an explicit
 * "Change status" form. Only this save ever changes it. "Saved" is announced only after the 200,
 * and a "nothing to change" answer is treated as saved.
 */
export function QuestionStatusForm({
  studyId,
  node,
  editable,
  onSaved,
  onLocked,
  refetch,
  onUnsavedChange,
}: {
  studyId: string;
  node: Question;
  editable: boolean;
  onSaved: () => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const name = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<QuestionStatus>(node.status);
  const [base, setBase] = useState(node);
  const [problem, setProblem] = useState<Problem | null>(null);
  const request = useFrozenRequest((body: UpdateNodeRequest, key: string) =>
    updateNode(studyId, node.id, body, key),
  );
  const unsaved = open && (request.pending || status !== base.status);
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    opener.current?.focus();
  }, [open]);

  function close() {
    returnFocus.current = true;
    setOpen(false);
  }

  async function save(retry = false) {
    const attempt = retry
      ? request.retry()
      : request.send({ expectedRevision: base.revision, status });
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok || codeOf(result.error) === NODE_UNCHANGED) {
      await refreshAfter(queryClient, studyId, node.id);
      close();
      onSaved();
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: CONCLUSION_COPY.unknown, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (statusOf(error) === 409) setProblem({ text: CONCLUSION_COPY.conflict, reload: true });
    else setProblem({ text: CONCLUSION_COPY.failed });
  }

  async function reload() {
    if (!window.confirm(CONCLUSION_COPY.reloadConfirm)) return;
    const fresh = (await refetch()) as { data?: NodeResponse };
    if (fresh.data?.type === 'question') {
      setBase(fresh.data);
      setStatus(fresh.data.status);
      setProblem(null);
    }
  }

  if (!editable) return null;
  if (!open) {
    return (
      <div>
        <button
          type="button"
          ref={opener}
          onClick={() => {
            setStatus(node.status);
            setBase(node);
            setProblem(null);
            setOpen(true);
          }}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Change status
        </button>
      </div>
    );
  }
  return (
    <form
      noValidate
      aria-label="Change question status"
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <StatusRadios
        legend="Status"
        name={`${name}-status`}
        options={QUESTION_STATUSES}
        value={status}
        onChange={setStatus}
      />
      {problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() => void save(true)}
          onReload={() => void reload()}
        />
      ) : null}
      <SaveCancel pending={request.pending} onCancel={close} />
    </form>
  );
}

type Mode = 'idle' | 'revise' | 'status';

/**
 * A Conclusion's header and explicit actions (BIB-30; FR-CONCLUSION-001...005): "Version N", the
 * "Established by me" marker and the "Evidence incomplete" warning as text, a Revise statement
 * form (a reason is required), a Change status form (Tentative, Supported, Challenged, Abandoned;
 * Supported can be marked established in the same save, Abandoned needs a reason), and the marker
 * button. Every save is one request with one Idempotency-Key that Retry resends verbatim; "Saved"
 * is announced only after the 200. The server asks for evidence before Supported (422); the
 * "Connect evidence" button then opens the Connect dialog on this conclusion. History lists the
 * immutable versions.
 */
export function ConclusionActions({
  studyId,
  node,
  editable,
  onSaved,
  onLocked,
  refetch,
  onUnsavedChange,
  onConnectEvidence,
  connecting,
}: {
  studyId: string;
  node: Conclusion;
  editable: boolean;
  onSaved: () => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
  onUnsavedChange?: (unsaved: boolean) => void;
  /** Opens the Connect dialog (hosted by Relationships) on this conclusion. */
  onConnectEvidence: () => void;
  /** The Connect dialog opened from here is open; when it closes, focus returns to the button. */
  connecting: boolean;
}) {
  const queryClient = useQueryClient();
  const names = useId();
  const reviseButton = useRef<HTMLButtonElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const markerButton = useRef<HTMLButtonElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<'revise' | 'status' | null>(null);
  const wasConnecting = useRef(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [base, setBase] = useState(node);
  const [text, setText] = useState(node.text);
  const [reason, setReason] = useState('');
  const [choice, setChoice] = useState<ConclusionStatus | null>(null);
  const [mark, setMark] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const request = useFrozenRequest((body: UpdateNodeRequest, key: string) =>
    updateNode(studyId, node.id, body, key),
  );

  const established = node.establishedAt !== null;
  const baseEstablished = base.establishedAt !== null;
  const changed =
    mode === 'revise'
      ? text !== base.text || reason !== ''
      : mode === 'status'
        ? choice !== (CHOOSABLE.includes(base.status) ? base.status : null) ||
          mark !== baseEstablished ||
          reason !== ''
        : false;
  const unsaved = mode !== 'idle' && (request.pending || changed);
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  useEffect(() => {
    if (mode !== 'idle' || !returnTo.current) return;
    (returnTo.current === 'revise' ? reviseButton : statusButton).current?.focus();
    returnTo.current = null;
  }, [mode]);
  useEffect(() => {
    if (wasConnecting.current && !connecting) connectButton.current?.focus();
    wasConnecting.current = connecting;
  }, [connecting]);

  function reset(from: Conclusion) {
    setBase(from);
    setText(from.text);
    setReason('');
    setChoice(CHOOSABLE.includes(from.status) ? from.status : null);
    setMark(from.establishedAt !== null);
    setErrors({});
    setProblem(null);
    setEvidenceError(null);
  }

  function openMode(next: 'revise' | 'status') {
    reset(node);
    setSaved('');
    setMode(next);
  }

  function close() {
    returnTo.current = mode === 'revise' ? 'revise' : 'status';
    setMode('idle');
    setEvidenceError(null);
  }

  /** Sends one request: validates it with the shared schema, then reports the server's answer. */
  async function send(body: UpdateNodeRequest | null, retry = false, finish: () => void = close) {
    let attempt;
    if (retry) attempt = request.retry();
    else {
      if (!body) return;
      const parsed = updateNodeRequestSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(fieldErrorsOf(parsed.error.issues));
        return;
      }
      setErrors({});
      attempt = request.send(body);
    }
    if (!attempt) return;
    setProblem(null);
    setEvidenceError(null);
    const result = await attempt;
    if (result.ok || codeOf(result.error) === NODE_UNCHANGED) {
      const cleared = result.ok && result.value.warnings.includes('establishment_cleared');
      // The section announces "Saved"; this adds the notice only when the marker went.
      setSaved(cleared ? CONCLUSION_COPY.savedCleared : '');
      await refreshAfter(queryClient, studyId, node.id);
      finish();
      onSaved();
      return;
    }
    const { error } = result;
    const code = codeOf(error);
    if (result.unknown) setProblem({ text: CONCLUSION_COPY.unknown, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (code === CONCLUSION_EVIDENCE_REQUIRED)
      setEvidenceError(CONCLUSION_COPY.evidenceRequired);
    else if (code === CONCLUSION_NOT_SUPPORTED) setEvidenceError(CONCLUSION_COPY.notSupported);
    else if (statusOf(error) === 409) setProblem({ text: CONCLUSION_COPY.conflict, reload: true });
    else setProblem({ text: CONCLUSION_COPY.failed });
  }

  async function reload() {
    if (!window.confirm(CONCLUSION_COPY.reloadConfirm)) return;
    const fresh = (await refetch()) as { data?: NodeResponse };
    if (fresh.data?.type === 'conclusion') reset(fresh.data);
  }

  function saveRevision() {
    if (reason.trim() === '') {
      setErrors({ changeReason: 'Say why you are revising this.' });
      return;
    }
    void send({
      expectedRevision: base.revision,
      text,
      changeReason: reason,
    });
  }

  function saveStatus() {
    if (choice === null) {
      setErrors({ status: 'Choose a status.' });
      return;
    }
    const sameStatus = choice === base.status;
    let establishment: 'set' | 'clear' | undefined;
    if (choice === 'supported') {
      if (mark && !baseEstablished) establishment = 'set';
      else if (!mark && baseEstablished) establishment = 'clear';
    }
    if (sameStatus && establishment === undefined) {
      setProblem({ text: CONCLUSION_COPY.unchanged });
      return;
    }
    void send({
      expectedRevision: base.revision,
      ...(sameStatus ? {} : { status: choice }),
      ...(establishment ? { establishment } : {}),
      ...(reason.trim() ? { changeReason: reason } : {}),
    });
  }

  function toggleMarker() {
    void send(
      {
        expectedRevision: node.revision,
        establishment: established ? 'clear' : 'set',
      },
      false,
      () => markerButton.current?.focus(),
    );
  }

  const canMark = node.status === 'supported' && (established || node.liveEvidenceCount > 0);
  const clearsMarker =
    baseEstablished && (mode === 'revise' || (mode === 'status' && choice !== 'supported'));
  const connectInWarning = node.evidenceIncomplete && !evidenceError;

  const connectEvidence = (
    <button
      type="button"
      ref={connectButton}
      aria-haspopup="dialog"
      onClick={onConnectEvidence}
      className="rounded border border-accent px-3 py-1 text-accent"
    >
      Connect evidence
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p>
          <span className="font-medium">Version {node.version.number}</span>
        </p>
        {established ? (
          <p>
            <span className="rounded border border-ink px-1">{ESTABLISHED_TEXT}</span>{' '}
            <span className="text-sm">{CONCLUSION_COPY.establishedHelp}</span>
          </p>
        ) : null}
        {node.evidenceIncomplete ? (
          <div role="status" className="flex flex-wrap items-center gap-3">
            <p>
              <span aria-hidden="true">⚠ </span>
              {CONCLUSION_COPY.incomplete}
            </p>
            {editable && connectInWarning ? connectEvidence : null}
          </div>
        ) : null}
        <p role="status" aria-live="polite" className="text-sm">
          {saved}
        </p>
      </div>

      {editable && mode === 'idle' ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            ref={reviseButton}
            onClick={() => openMode('revise')}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Revise statement
          </button>
          <button
            type="button"
            ref={statusButton}
            onClick={() => openMode('status')}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Change status
          </button>
          {canMark ? (
            <button
              type="button"
              ref={markerButton}
              aria-disabled={request.pending ? true : undefined}
              onClick={() => {
                if (!request.pending) toggleMarker();
              }}
              className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
            >
              {established ? "Remove 'Established by me'" : 'Mark as established by me'}
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === 'idle' && problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() => void send(null, true)}
          onReload={() => void reload()}
        />
      ) : null}
      {mode === 'idle' && evidenceError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{evidenceError}</p>
          {evidenceError === CONCLUSION_COPY.evidenceRequired ? connectEvidence : null}
        </div>
      ) : null}

      {editable && mode === 'revise' ? (
        <form
          noValidate
          aria-label="Revise conclusion"
          className="flex flex-col gap-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            saveRevision();
          }}
        >
          <TextAreaField
            label="Statement"
            value={text}
            onChange={setText}
            max={MAX_QUESTION_LENGTH}
            error={errors.text}
          />
          <TextAreaField
            label="Why are you revising this?"
            value={reason}
            onChange={setReason}
            max={MAX_CHANGE_REASON_LENGTH}
            error={errors.changeReason}
            rows={2}
          />
          <p className="text-sm">{CONCLUSION_COPY.reviseHelp}</p>
          {clearsMarker ? <p>{CONCLUSION_COPY.clearsMarker}</p> : null}
          {problem ? (
            <ProblemLine
              problem={problem}
              onRetry={() => void send(null, true)}
              onReload={() => void reload()}
            />
          ) : null}
          <SaveCancel pending={request.pending} onCancel={close} />
        </form>
      ) : null}

      {editable && mode === 'status' ? (
        <form
          noValidate
          aria-label="Change conclusion status"
          className="flex flex-col gap-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            saveStatus();
          }}
        >
          <StatusRadios
            legend="Status"
            name={`${names}-status`}
            options={CHOOSABLE}
            value={choice}
            onChange={(next) => {
              setChoice(next);
              setEvidenceError(null);
              setErrors({});
            }}
            describedBy={errors.status || evidenceError ? `${names}-status-error` : undefined}
          />
          {base.status === 'revised' ? (
            <p className="text-sm">The current status is Revised. Choose another to change it.</p>
          ) : null}
          {errors.status ? (
            <p id={`${names}-status-error`} className="text-accent">
              {errors.status}
            </p>
          ) : null}
          {evidenceError ? (
            <div id={`${names}-status-error`} role="alert" className="flex flex-wrap gap-3">
              <p>{evidenceError}</p>
              {evidenceError === CONCLUSION_COPY.evidenceRequired ? connectEvidence : null}
            </div>
          ) : (
            <p className="text-sm">{CONCLUSION_COPY.evidenceHelp}</p>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={mark}
              disabled={choice !== 'supported'}
              onChange={(event) => setMark(event.target.checked)}
            />
            Mark as established by me
          </label>
          <TextAreaField
            label={
              choice === 'abandoned'
                ? 'Why are you abandoning this? (required)'
                : 'Why are you changing the status? (optional)'
            }
            value={reason}
            onChange={setReason}
            max={MAX_CHANGE_REASON_LENGTH}
            error={errors.changeReason}
            rows={2}
          />
          {clearsMarker ? <p>{CONCLUSION_COPY.clearsMarker}</p> : null}
          {problem ? (
            <ProblemLine
              problem={problem}
              onRetry={() => void send(null, true)}
              onReload={() => void reload()}
            />
          ) : null}
          <SaveCancel pending={request.pending} onCancel={close} />
        </form>
      ) : null}

      <History studyId={studyId} nodeId={node.id} versions={node.version.number} />
    </div>
  );
}

/** The sentence for one piece of a version's evidence, from the conclusion's point of view. */
function evidenceSentence(conclusionId: string, evidence: NodeVersion['evidence'][number]) {
  const other = `${NODE_TYPE_NAMES[evidence.nodeType]}: ${evidence.label}`;
  const edge =
    evidence.edgeType === 'inference_from'
      ? { sourceNodeId: conclusionId, targetNodeId: evidence.nodeId, type: evidence.edgeType }
      : { sourceNodeId: evidence.nodeId, targetNodeId: conclusionId, type: evidence.edgeType };
  return sentenceFrom(edge, { id: conclusionId, type: 'conclusion' }, other);
}

function VersionItem({ conclusionId, version }: { conclusionId: string; version: NodeVersion }) {
  return (
    <li className="flex flex-col gap-1 rounded border border-muted p-3">
      <p className="font-medium">
        Version {version.versionNumber} · {NODE_STATUS_NAMES[version.status]} ·{' '}
        {formatNodeTime(version.createdAt)}
      </p>
      <p className="break-words whitespace-pre-wrap">{version.statement}</p>
      {version.established ? <p>{ESTABLISHED_TEXT}</p> : null}
      {version.action === 'evidence_removed' ? <p>{CONCLUSION_COPY.evidenceRemoved}</p> : null}
      {version.changeReason ? (
        <p className="break-words whitespace-pre-wrap">Reason: {version.changeReason}</p>
      ) : null}
      {version.evidence.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {version.evidence.map((evidence) => (
            <li key={evidence.edgeId} className="break-words">
              {evidenceSentence(conclusionId, evidence)}
              {evidence.role === 'challenging' ? ' (challenging)' : ''}
              {!evidence.edgeLive ? ' (relationship changed or removed since)' : ''}
              {!evidence.nodeLive ? ' (node deleted)' : ''}
              {evidence.nodeLive && evidence.nodeChangedSince ? ' (edited since this version)' : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The conclusion's versions, loaded only once the disclosure is opened. */
function History({
  studyId,
  nodeId,
  versions,
}: {
  studyId: string;
  nodeId: string;
  versions: number;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: nodeVersionsQueryKey(studyId, nodeId),
    queryFn: () => fetchNodeVersions(studyId, nodeId),
    enabled: open,
  });
  const items = history.data?.items;
  let body: ReactNode = null;
  if (open) {
    if (history.isError) {
      body = (
        <ProblemAlert
          error={history.error}
          copy={HISTORY_COPY}
          onRetry={() => void history.refetch()}
        />
      );
    } else if (!items) {
      body = (
        <p role="status" className="text-muted">
          {CONCLUSION_COPY.historyLoading}
        </p>
      );
    } else if (items.length === 0) {
      body = <p className="text-muted">{CONCLUSION_COPY.historyEmpty}</p>;
    } else {
      body = (
        <ul className="flex flex-col gap-2">
          {items.map((version) => (
            <VersionItem key={version.id} conclusionId={nodeId} version={version} />
          ))}
        </ul>
      );
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="self-start rounded border border-muted px-3 py-1"
      >
        History ({versions.toLocaleString('en-US')} {versions === 1 ? 'version' : 'versions'})
      </button>
      <div id={panelId} hidden={!open}>
        {body}
      </div>
    </div>
  );
}
