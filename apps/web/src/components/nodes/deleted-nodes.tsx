'use client';

import {
  NODE_LIMIT_EXCEEDED,
  NODE_NOT_DELETED,
  NODE_TYPE_NAMES,
  type NodeRestoreResponse,
  type NodeStateRequest,
  type SkippedEdgeReason,
  type StudyNodeType,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { deletedNodesQueryKey, formatNodeTime, listDeletedNodes, restoreNode } from '@/lib/nodes';
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

/** Fixed copy for deleting and restoring nodes (BIB-31): types and labels, never other text. */
export const DELETED_NODES_COPY = {
  disclosure: 'Deleted nodes',
  loading: 'Loading deleted nodes…',
  empty: 'No deleted nodes.',
  conflict: 'This deleted node changed. Try again.',
  notDeleted: 'It was already restored.',
  limit: 'This study holds the most nodes it can (2,000), so the node was not restored.',
  unknown: "Couldn't confirm the node was restored. Retry won't restore it twice.",
  failed: "Couldn't restore the node.",
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "This study's deleted nodes aren't available.",
  refused: "Couldn't load the deleted nodes.",
  unavailable: "Couldn't load the deleted nodes.",
};

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const SKIP_REASONS: Record<SkippedEdgeReason, string> = {
  endpoint_deleted: 'the other node is deleted (they come back when you restore it)',
  duplicate: 'the same relationship already exists',
  limit: "the study's relationship limit was reached",
};

/** "Deleted Observation: Paul appeals…." with the conclusions whose marker went. */
export function deletedText(type: StudyNodeType, label: string, clearedCount: number): string {
  const cleared =
    clearedCount > 0
      ? ` 'Established by me' was cleared on ${count(clearedCount, 'conclusion', 'conclusions')} that lost their last evidence.`
      : '';
  return `Deleted ${NODE_TYPE_NAMES[type]}: ${label}.${cleared}`;
}

/** What a restore did, as sentences (counts per reason, a duplicate, a cleared marker). */
export function restoredText(
  result: NodeRestoreResponse,
  label: string,
  labelOf: (id: string) => string | null,
): string {
  const parts = [
    `Restored ${NODE_TYPE_NAMES[result.type]}: ${label}. ${count(result.restoredEdgeIds.length, 'relationship', 'relationships')} restored.`,
  ];
  if (result.skippedEdges.length > 0) {
    const reasons = (Object.keys(SKIP_REASONS) as SkippedEdgeReason[]).flatMap((reason) => {
      const n = result.skippedEdges.filter((edge) => edge.reason === reason).length;
      return n > 0 ? [`${n.toLocaleString('en-US')}: ${SKIP_REASONS[reason]}`] : [];
    });
    parts.push(
      `${count(result.skippedEdges.length, "relationship wasn't", "relationships weren't")} restored: ${reasons.join('; ')}.`,
    );
  }
  if (result.canonicalNodeId) {
    parts.push(
      `It was restored as a duplicate of ${labelOf(result.canonicalNodeId) ?? 'the passage already in the study'} because that passage is already in the study.`,
    );
  }
  if (result.establishmentClearedNodeIds.includes(result.id)) {
    parts.push("'Established by me' was cleared because it has no remaining evidence.");
  }
  return parts.join(' ');
}

/**
 * One restore request at a time (BIB-31): `POST /nodes/:id/restore` with the deleted node's
 * revision and an Idempotency-Key that Retry resends verbatim. On success everything under the
 * study's key is refreshed (graph, lists, node details and histories, notes, the study header).
 */
export function useNodeRestore({
  studyId,
  onRestored,
  onLocked,
}: {
  studyId: string;
  onRestored: (result: NodeRestoreResponse, label: string) => void;
  onLocked: () => void;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [label, setLabel] = useState('');
  const record = useUndoRecorder();
  const request = useFrozenRequest((body: NodeStateRequest & { nodeId: string }, key: string) =>
    restoreNode(studyId, body.nodeId, { expectedRevision: body.expectedRevision }, key),
  );

  async function settle(attempt: ReturnType<typeof request.send>, named: string) {
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok) {
      record(
        {
          label: nodeCommandLabel('Restore', result.value.type),
          action: { op: 'deleteNode', nodeId: result.value.id },
        },
        { [nodeKey(result.value.id)]: result.value.revision, [FORGET_EDGES]: null },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId) }),
        invalidateLibrary(queryClient),
      ]);
      onRestored(result.value, named);
      return;
    }
    const { error } = result;
    const code = codeOf(error);
    if (result.unknown) setProblem({ text: DELETED_NODES_COPY.unknown, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (statusOf(error) === 409 || code === NODE_NOT_DELETED || statusOf(error) === 404) {
      setProblem({
        text:
          code === NODE_NOT_DELETED ? DELETED_NODES_COPY.notDeleted : DELETED_NODES_COPY.conflict,
      });
      void queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId) });
    } else if (code === NODE_LIMIT_EXCEEDED) setProblem({ text: DELETED_NODES_COPY.limit });
    else setProblem({ text: DELETED_NODES_COPY.failed });
  }

  return {
    pending: request.pending,
    problem,
    restore(nodeId: string, expectedRevision: number, named: string) {
      if (request.pending) return;
      setLabel(named);
      void settle(request.send({ nodeId, expectedRevision }), named);
    },
    retry() {
      void settle(request.retry(), label);
    },
  };
}

/**
 * The Nodes section's "Deleted nodes" disclosure (BIB-31): lazy-loads `GET /nodes?state=deleted`
 * when opened. Rows say type, label and when; Restore only on an editable study.
 */
export function DeletedNodes({
  studyId,
  editable,
  restore,
}: {
  studyId: string;
  editable: boolean;
  restore: ReturnType<typeof useNodeRestore>;
}) {
  const [open, setOpen] = useState(false);
  const deleted = useQuery({
    queryKey: deletedNodesQueryKey(studyId),
    queryFn: () => listDeletedNodes(studyId),
    enabled: open,
  });
  const items = deleted.data?.items ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded border border-muted px-3 py-1"
        >
          {DELETED_NODES_COPY.disclosure}
        </button>
      </div>
      {open ? (
        deleted.isError ? (
          <ProblemAlert
            error={deleted.error}
            copy={LOAD_COPY}
            onRetry={() => void deleted.refetch()}
          />
        ) : !deleted.data ? (
          <p role="status" className="text-muted">
            {DELETED_NODES_COPY.loading}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted">{DELETED_NODES_COPY.empty}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((node) => {
              const name = `${NODE_TYPE_NAMES[node.type]}: ${node.label}`;
              return (
                <li key={node.id} className="flex flex-wrap items-center gap-3">
                  <span className="break-words">
                    {NODE_TYPE_NAMES[node.type]} · {node.label} · Deleted{' '}
                    {formatNodeTime(node.deletedAt)}
                  </span>
                  {editable ? (
                    <button
                      type="button"
                      aria-label={`Restore ${name}`}
                      aria-disabled={restore.pending ? true : undefined}
                      onClick={() => restore.restore(node.id, node.revision, node.label)}
                      className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
                    >
                      Restore
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {restore.problem ? (
        <ProblemLine problem={restore.problem} onRetry={() => restore.retry()} />
      ) : null}
    </div>
  );
}
