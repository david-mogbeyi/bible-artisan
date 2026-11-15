'use client';

import {
  EDGE_ENDPOINT_DELETED,
  EDGE_EXISTS,
  EDGE_LIMIT_EXCEEDED,
  MAX_EDGES_PER_STUDY,
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
import { edgeSentence, restoreEdge } from '@/lib/edges';
import { deletedNodesQueryKey, formatNodeTime, listDeletedNodes, restoreNode } from '@/lib/nodes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { edgeKey, nodeCommandLabel, nodeRestoreRevisions, useUndoRecorder } from '@/lib/undo';
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

/** Fixed copy for relationships a node restore skipped, restored one by one afterwards. */
export const SKIPPED_EDGES_COPY = {
  heading: "Relationships that weren't restored",
  endpointDeleted: 'Comes back when you restore the other node.',
  duplicate:
    'The same relationship already exists, so this one stayed deleted. Remove that one first if you want this one back (for example, to keep its note).',
  limit: `The study was at its relationship limit (${MAX_EDGES_PER_STUDY.toLocaleString('en-US')}). Remove a relationship you don't need, then restore this one.`,
  restored: 'Relationship restored.',
  stillDuplicate: 'The same relationship still exists. Remove it first.',
  stillLimit: 'The study is still at its relationship limit. Remove a relationship first.',
  endpointGone: 'One of these nodes is deleted now. Restore it first.',
  conflict: 'This relationship changed since. Reload the page to see it.',
  unknown: "Couldn't confirm the relationship was restored. Retry won't restore it twice.",
  failed: "Couldn't restore the relationship.",
  dismiss: 'Dismiss',
} as const;

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
        nodeRestoreRevisions(result.value),
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

type SkippedEdge = NodeRestoreResponse['skippedEdges'][number];

/**
 * After a node restore, the relationships it skipped, each as a sentence with why (BIB-31). One
 * skipped as a duplicate or at the relationship limit stays deleted but recoverable: its Restore
 * button sends `POST /edges/:edgeId/restore` with the revision the node restore reported, so once
 * the identical one is removed or there is room it comes back under its own id. One whose other
 * end is deleted comes back with that node's restore, so it has no button.
 */
export function SkippedRelationships({
  studyId,
  edges,
  editable,
  nameOf,
  onDismiss,
  onLocked,
}: {
  studyId: string;
  edges: SkippedEdge[];
  editable: boolean;
  /** "Thought: …" for a live node, else null. */
  nameOf: (id: string) => string | null;
  onDismiss: () => void;
  onLocked: () => void;
}) {
  const [done, setDone] = useState<string[]>([]);
  const shown = edges.filter((edge) => !done.includes(edge.edgeId));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={SKIPPED_EDGES_COPY.heading} className="flex flex-col gap-2">
      <p className="font-semibold">{SKIPPED_EDGES_COPY.heading}</p>
      <ul className="flex flex-col gap-2">
        {shown.map((edge) => (
          <SkippedRelationship
            key={edge.edgeId}
            studyId={studyId}
            edge={edge}
            editable={editable}
            nameOf={nameOf}
            onRestored={() => setDone((ids) => [...ids, edge.edgeId])}
            onLocked={onLocked}
          />
        ))}
      </ul>
      <div>
        <button type="button" onClick={onDismiss} className="underline">
          {SKIPPED_EDGES_COPY.dismiss}
        </button>
      </div>
    </div>
  );
}

function SkippedRelationship({
  studyId,
  edge,
  editable,
  nameOf,
  onRestored,
  onLocked,
}: {
  studyId: string;
  edge: SkippedEdge;
  editable: boolean;
  nameOf: (id: string) => string | null;
  onRestored: () => void;
  onLocked: () => void;
}) {
  const queryClient = useQueryClient();
  const record = useUndoRecorder();
  const [problem, setProblem] = useState<Problem | null>(null);
  const request = useFrozenRequest((body: { expectedRevision: number }, key: string) =>
    restoreEdge(studyId, edge.edgeId, body, key),
  );
  const name = (id: string) => nameOf(id) ?? 'a deleted node';
  const sentence = edgeSentence(name(edge.sourceNodeId), edge.type, name(edge.targetNodeId));
  const why =
    edge.reason === 'endpoint_deleted'
      ? SKIPPED_EDGES_COPY.endpointDeleted
      : edge.reason === 'duplicate'
        ? SKIPPED_EDGES_COPY.duplicate
        : SKIPPED_EDGES_COPY.limit;

  async function settle(attempt: ReturnType<typeof request.send>) {
    if (!attempt) return;
    setProblem(null);
    const result = await attempt;
    if (result.ok) {
      record(
        { label: 'Restore relationship', action: { op: 'removeEdge', edgeId: edge.edgeId } },
        { [edgeKey(edge.edgeId)]: result.value.revision },
      );
      await queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId) });
      onRestored();
      return;
    }
    const { error } = result;
    const code = codeOf(error);
    if (result.unknown) setProblem({ text: SKIPPED_EDGES_COPY.unknown, retry: true });
    else if (isLifecycle(error)) onLocked();
    else if (code === EDGE_EXISTS) setProblem({ text: SKIPPED_EDGES_COPY.stillDuplicate });
    else if (code === EDGE_LIMIT_EXCEEDED) setProblem({ text: SKIPPED_EDGES_COPY.stillLimit });
    else if (code === EDGE_ENDPOINT_DELETED) setProblem({ text: SKIPPED_EDGES_COPY.endpointGone });
    else if (statusOf(error) === 409 || statusOf(error) === 404) {
      setProblem({ text: SKIPPED_EDGES_COPY.conflict });
    } else setProblem({ text: SKIPPED_EDGES_COPY.failed });
  }

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <span className="break-words">
          {sentence}. {why}
        </span>
        {editable && edge.reason !== 'endpoint_deleted' ? (
          <button
            type="button"
            aria-label={`Restore relationship: ${sentence}`}
            aria-disabled={request.pending ? true : undefined}
            onClick={() => void settle(request.send({ expectedRevision: edge.revision }))}
            className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
          >
            Restore
          </button>
        ) : null}
      </div>
      {problem ? (
        <ProblemLine problem={problem} onRetry={() => void settle(request.retry())} />
      ) : null}
    </li>
  );
}
