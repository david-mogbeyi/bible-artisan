'use client';

import {
  type CreateNodeResponse,
  type DuplicateNodeResponse,
  NODE_LIMIT_EXCEEDED,
  NODE_TYPE_NAMES,
  NODE_UNCHANGED,
  type NodeDeleteResponse,
  type NodeResponse,
  type NodeStateRequest,
  type StudyNodeType,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import {
  addProblemText,
  isLifecycleRefusal,
  NODE_ADD_COPY,
  outcomeText,
  scriptureRequest,
  useAddNode,
} from '@/lib/add-node';
import { deletionImpact } from '@/lib/deletion-impact';
import { fetchGraph, graphQueryKey, invalidateGraph } from '@/lib/graph';
import {
  deleteNode,
  duplicateNode,
  ESTABLISHED_TEXT,
  invalidateNodeChange,
  nodesQueryKey,
  updateNode,
} from '@/lib/nodes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { FORGET_EDGES, nodeCommandLabel, nodeKey, useUndoRecorder } from '@/lib/undo';
import {
  codeOf,
  isLifecycle,
  type Problem,
  ProblemLine,
  statusOf,
  useFrozenRequest,
} from './relationship-controls';

/** Fixed copy for node detail's marker, duplicate and delete actions (BIB-62, BIB-61, BIB-31). */
export const NODE_ACTION_COPY = {
  establishedHelp: 'You marked this as established in this study. It is not a universal claim.',
  mark: 'Mark as established by me',
  unmark: "Remove 'Established by me'",
  marked: 'Marked as established by me.',
  unmarked: "'Established by me' removed.",
  markConflict: 'This node changed somewhere else. Reload to see it.',
  markUnknown: "Couldn't confirm the change was saved. Retry won't save it twice.",
  markFailed: "Couldn't save the change.",
  editClears: "Saving changes clears 'Established by me'. You can mark it again after saving.",
  savedCleared: "Saved. 'Established by me' was cleared.",
  duplicateGone: 'This node is no longer in the study.',
  deleteConflict: 'This node changed somewhere else. Review it, then delete again.',
  deleteGone: 'This node was already deleted.',
  deleteUnknown: "Couldn't confirm the node was deleted. Retry won't delete it twice.",
  deleteFailed: "Couldn't delete the node.",
} as const;

/** "Duplicated Conclusion. The copy has no relationships. It starts Tentative, …" */
export function duplicatedText(type: StudyNodeType, sourceEstablished: boolean): string {
  const extra =
    type === 'question'
      ? ' It starts Open.'
      : type === 'conclusion'
        ? " It starts Tentative, without 'Established by me'."
        : type === 'observation' && sourceEstablished
          ? " It isn't marked 'Established by me'."
          : '';
  return `Duplicated ${NODE_TYPE_NAMES[type]}. The copy has no relationships.${extra}`;
}

/** The "Established by me" marker as text, with what it means (PRD section 8). */
export function EstablishedMarker() {
  return (
    <p>
      <span className="rounded border border-ink px-1">{ESTABLISHED_TEXT}</span>{' '}
      <span className="text-sm">{NODE_ACTION_COPY.establishedHelp}</span>
    </p>
  );
}

const buttonClass = 'rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60';

/**
 * An observation's "Mark as established by me" / "Remove 'Established by me'" (BIB-62): one PATCH
 * with `establishment` alone, its Idempotency-Key resent verbatim by Retry. Focus stays on the
 * button, which then shows its other label.
 */
export function ObservationMarkerButton({
  studyId,
  node,
  onAnnounce,
  onLocked,
  refetch,
}: {
  studyId: string;
  node: Extract<NodeResponse, { type: 'observation' }>;
  onAnnounce: (text: string) => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const established = node.establishedAt !== null;
  const [problem, setProblem] = useState<Problem | null>(null);
  const request = useFrozenRequest((body: UpdateNodeRequest, key: string) =>
    updateNode(studyId, node.id, body, key),
  );

  async function run(retry = false) {
    const attempt = retry
      ? request.retry()
      : request.send({
          expectedRevision: node.revision,
          establishment: established ? 'clear' : 'set',
        });
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok || codeOf(result.error) === NODE_UNCHANGED) {
      await Promise.all([
        invalidateNodeChange(queryClient, studyId, node.id),
        invalidateLibrary(queryClient),
      ]);
      if (result.ok) onAnnounce(established ? NODE_ACTION_COPY.unmarked : NODE_ACTION_COPY.marked);
      return;
    }
    if (result.unknown) setProblem({ text: NODE_ACTION_COPY.markUnknown, retry: true });
    else if (isLifecycle(result.error)) onLocked();
    else if (statusOf(result.error) === 409) {
      setProblem({ text: NODE_ACTION_COPY.markConflict, reload: true });
    } else setProblem({ text: NODE_ACTION_COPY.markFailed });
  }

  return (
    <>
      <button
        type="button"
        aria-disabled={request.pending ? true : undefined}
        onClick={() => {
          if (!request.pending) void run();
        }}
        className={buttonClass}
      >
        {request.pending
          ? 'Saving…'
          : established
            ? NODE_ACTION_COPY.unmark
            : NODE_ACTION_COPY.mark}
      </button>
      {problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() => void run(true)}
          onReload={() => {
            setProblem(null);
            void refetch();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Duplicate <Type>" (BIB-61): a new node with this one's saved content and nothing else, on the
 * study's current revision with its own Idempotency-Key (Retry resends it verbatim after an
 * unknown outcome). The section selects the copy and announces it.
 */
export function DuplicateButton({
  studyId,
  node,
  studyRevision,
  established,
  onCopied,
  onLocked,
}: {
  studyId: string;
  node: NodeResponse;
  studyRevision: number;
  /** The source is "Established by me" (the copy never is). */
  established: boolean;
  onCopied: (id: string, studyRevision: number, announcement: string) => void;
  onLocked: () => void;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const record = useUndoRecorder();
  const request = useFrozenRequest((body: { expectedRevision: number }, key: string) =>
    duplicateNode(studyId, node.id, body, key),
  );

  async function run(retry = false) {
    const attempt = retry ? request.retry() : request.send({ expectedRevision: studyRevision });
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok) {
      const copy: DuplicateNodeResponse = result.value;
      record(
        {
          label: nodeCommandLabel('Duplicate', node.type),
          action: { op: 'deleteNode', nodeId: copy.id },
        },
        { [nodeKey(copy.id)]: copy.revision },
      );
      onCopied(copy.id, copy.studyRevision, duplicatedText(node.type, established));
      return;
    }
    const { error } = result;
    if (result.unknown) setProblem({ text: NODE_ADD_COPY.unknown, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (statusOf(error) === 409) {
      setProblem({ text: NODE_ADD_COPY.conflict('Duplicate') });
      void queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId), exact: true });
    } else if (statusOf(error) === 404) {
      setProblem({ text: NODE_ACTION_COPY.duplicateGone });
      void queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) });
      void invalidateGraph(queryClient, studyId);
    } else if (codeOf(error) === NODE_LIMIT_EXCEEDED) setProblem({ text: NODE_ADD_COPY.limit });
    else setProblem({ text: NODE_ADD_COPY.failed });
  }

  return (
    <>
      <button
        type="button"
        aria-disabled={request.pending ? true : undefined}
        onClick={() => {
          if (!request.pending) void run();
        }}
        className={buttonClass}
      >
        {request.pending ? (
          'Duplicating…'
        ) : (
          <>
            Duplicate <span className="sr-only">{NODE_TYPE_NAMES[node.type]}</span>
          </>
        )}
      </button>
      {problem ? <ProblemLine problem={problem} onRetry={() => void run(true)} /> : null}
    </>
  );
}

/**
 * A Scripture node's "Add a separate copy" (BIB-26's labeled duplicate, reachable from node detail
 * by BIB-61): the same Add with `explicit_duplicate` through `useAddNode`.
 */
export function ScriptureCopyButton({
  studyId,
  referenceId,
  label,
  studyRevision,
  onCopied,
  onLocked,
  onReload,
}: {
  studyId: string;
  referenceId: string;
  label: string;
  studyRevision: number;
  onCopied: (id: string, studyRevision: number, announcement: string) => void;
  onLocked: () => void;
  onReload: () => void;
}) {
  const add = useAddNode(studyId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function run(retry = false) {
    const request = retry
      ? add.retry()
      : add.send(scriptureRequest(referenceId, studyRevision, 'explicit_duplicate'), null);
    if (!request) return;
    setProblem(null);
    const result = await request;
    if (result.ok) {
      const node: CreateNodeResponse = result.node;
      onCopied(node.id, node.studyRevision, outcomeText(node, label));
      return;
    }
    if (isLifecycleRefusal(result.problem)) {
      onLocked();
      return;
    }
    if (result.problem.kind === 'conflict') onReload();
    setProblem({
      text: addProblemText(result.problem, NODE_ADD_COPY.separateCopy),
      retry: result.problem.kind === 'unknown',
    });
  }

  return (
    <>
      <button
        type="button"
        aria-disabled={add.pending ? true : undefined}
        onClick={() => {
          if (!add.pending) void run();
        }}
        className={buttonClass}
      >
        {NODE_ADD_COPY.separateCopy}
      </button>
      {problem ? <ProblemLine problem={problem} onRetry={() => void run(true)} /> : null}
    </>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/**
 * "Delete node…" (BIB-31): a native modal dialog that says, before anything is sent, what the
 * deletion affects (computed from the cached graph snapshot), then one DELETE with the node's
 * revision and an Idempotency-Key. Focus starts on Cancel; Escape and Cancel are ignored while the
 * request is pending.
 */
export function DeleteNodeButton({
  studyId,
  node,
  label,
  mainQuestionNodeId,
  onDeleted,
  onLocked,
  refetch,
}: {
  studyId: string;
  node: NodeResponse;
  label: string;
  mainQuestionNodeId: string | null;
  onDeleted: (result: NodeDeleteResponse, type: StudyNodeType, label: string) => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [inDialogProblem, setInDialogProblem] = useState<Problem | null>(null);
  const graph = useQuery({
    queryKey: graphQueryKey(studyId),
    queryFn: () => fetchGraph(studyId),
    enabled: open,
  });
  const record = useUndoRecorder();
  const request = useFrozenRequest((body: NodeStateRequest, key: string) =>
    deleteNode(studyId, node.id, body, key),
  );
  const typeName = NODE_TYPE_NAMES[node.type];

  function openDialog() {
    setProblem(null);
    setInDialogProblem(null);
    setOpen(true);
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }

  function closeDialog() {
    if (request.pending) return;
    dialogRef.current?.close();
    setOpen(false);
    openerRef.current?.focus();
  }

  async function run(retry = false) {
    const attempt = retry ? request.retry() : request.send({ expectedRevision: node.revision });
    if (!attempt) return;
    setInDialogProblem(null);
    const result = await attempt;
    if (result.ok) {
      dialogRef.current?.close();
      setOpen(false);
      record(
        {
          label: nodeCommandLabel('Delete', node.type),
          action: { op: 'restoreNode', nodeId: node.id },
        },
        { [nodeKey(node.id)]: result.value.revision, [FORGET_EDGES]: null },
      );
      onDeleted(result.value, node.type, label);
      return;
    }
    const { error } = result;
    if (result.unknown) {
      setInDialogProblem({ text: NODE_ACTION_COPY.deleteUnknown, retry: true });
      return;
    }
    dialogRef.current?.close();
    setOpen(false);
    if (isLifecycle(error)) {
      onLocked();
      return;
    }
    openerRef.current?.focus();
    if (statusOf(error) === 409) {
      setProblem({ text: NODE_ACTION_COPY.deleteConflict });
      void refetch();
    } else if (statusOf(error) === 404) {
      setProblem({ text: NODE_ACTION_COPY.deleteGone });
      void queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) });
      void invalidateGraph(queryClient, studyId);
    } else setProblem({ text: NODE_ACTION_COPY.deleteFailed });
  }

  const impact = graph.data ? deletionImpact(graph.data, node.id, mainQuestionNodeId) : null;

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="dialog"
        onClick={openDialog}
        className={buttonClass}
      >
        Delete node…
      </button>
      {problem ? <ProblemLine problem={problem} /> : null}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeDialog();
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        className="m-auto max-w-md rounded border border-muted bg-canvas p-6 text-ink backdrop:bg-black/40"
      >
        <h2 id={titleId} className="font-serif text-2xl">
          Delete this node?
        </h2>
        <div id={textId} className="mt-2 flex flex-col gap-2">
          <p className="break-words">
            {typeName}: {label}
          </p>
          {open && !impact ? (
            <p>
              {graph.isError
                ? "Couldn't check what else this affects. The node and its relationships will still be restorable."
                : 'Checking what this affects…'}
            </p>
          ) : null}
          {impact ? <ImpactText impact={impact} /> : null}
          <p>
            Notes attached to it stay, under Orphaned notes. You can restore it from Deleted nodes.
          </p>
        </div>
        {inDialogProblem ? (
          <div className="mt-2">
            <ProblemLine problem={inDialogProblem} onRetry={() => void run(true)} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            aria-disabled={request.pending ? true : undefined}
            onClick={closeDialog}
            className={buttonClass}
          >
            Cancel
          </button>
          <button
            type="button"
            aria-disabled={request.pending ? true : undefined}
            onClick={() => {
              if (!request.pending) void run();
            }}
            className="rounded bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
          >
            {request.pending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </dialog>
    </>
  );
}

function ImpactText({ impact }: { impact: ReturnType<typeof deletionImpact> }) {
  const conclusions = impact.affectedConclusions;
  return (
    <>
      <p>
        {impact.edgeCount === 0
          ? 'It has no relationships.'
          : `Its ${plural(impact.edgeCount, 'relationship is', 'relationships are')} removed with it.`}
      </p>
      {conclusions.length > 0 ? (
        <>
          <p>{plural(conclusions.length, 'conclusion uses', 'conclusions use')} it as evidence:</p>
          <ul className="list-disc pl-6">
            {conclusions.map((c) => (
              <li key={c.node.id} className="break-words">
                Conclusion: {c.node.label}
                {c.leftWithoutEvidence ? ' — it will have no remaining evidence' : ''}
                {c.losesEstablished ? " and will lose 'Established by me'" : ''}
              </li>
            ))}
          </ul>
          <p>Your conclusions keep their status. Nothing is decided for you.</p>
        </>
      ) : null}
      {impact.isMainQuestion ? (
        <p>
          This is the study&apos;s main question. The study will have no main question until you
          choose one in study details.
        </p>
      ) : null}
      {impact.duplicateCount > 0 ? <p>Its oldest duplicate copy becomes the original.</p> : null}
      {impact.isBranchRoot ? (
        <p>
          It starts a branch. The branch stays, marked &apos;root deleted&apos;, until you restore
          it.
        </p>
      ) : null}
    </>
  );
}
