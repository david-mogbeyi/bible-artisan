import {
  type CreateNodeRequest,
  type CreateNodeResponse,
  createNodeResponseSchema,
  type DeletedNodeListResponse,
  deletedNodeListResponseSchema,
  type DuplicateNodeRequest,
  type DuplicateNodeResponse,
  duplicateNodeResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type NodeDeleteResponse,
  nodeDeleteResponseSchema,
  type NodeRestoreResponse,
  nodeRestoreResponseSchema,
  type NodeStateRequest,
  NODE_STATUS_NAMES,
  NODE_TYPE_NAMES,
  type NodeListResponse,
  nodeListResponseSchema,
  type NodeMutationResponse,
  nodeMutationResponseSchema,
  type NodeResponse,
  nodeResponseSchema,
  type NodeSummary,
  type NodeVersionListResponse,
  nodeVersionListResponseSchema,
  OBSERVATION_KIND_NAMES,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';
import { invalidateGraph } from './graph';
import { studyHref } from './studies';

/**
 * Typed graph node data access (BIB-25). Node text, citations and labels travel only in request
 * and response bodies; URLs carry opaque ids alone (PRD section 9, NFR-PRIV-001). Nothing here
 * touches browser storage. Every mutation takes an Idempotency-Key that a retry resends with the
 * identical body. These are domain DTOs; a canvas converts them to its own view objects.
 */

const nodesPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/nodes`;
const nodePath = (studyId: string, nodeId: string) =>
  `${nodesPath(studyId)}/${encodeURIComponent(nodeId)}`;

/** Under the study's key, so refreshing a study refreshes its nodes too. */
export function nodesQueryKey(studyId: string) {
  return ['studies', studyId, 'nodes', 'list'] as const;
}

export function nodeQueryKey(studyId: string, nodeId: string) {
  return ['studies', studyId, 'nodes', 'detail', nodeId] as const;
}

/**
 * A query filter for refreshing a study after these nodes were removed (deleted, or an add
 * undone): every query except the ones about a removed node (its detail, versions, relationships,
 * suggestions, reasoning), which could only 404 now. The open detail unmounts with the selection.
 */
export function notAboutNodes(nodeIds: readonly string[]) {
  return (query: { queryKey: readonly unknown[] }) =>
    !query.queryKey.slice(2).some((part) => typeof part === 'string' && nodeIds.includes(part));
}

/** A conclusion's version history (BIB-30), under the study's key like every node query. */
export function nodeVersionsQueryKey(studyId: string, nodeId: string) {
  return ['studies', studyId, 'nodes', 'versions', nodeId] as const;
}

export function listNodes(studyId: string): Promise<NodeListResponse> {
  return apiFetch(nodesPath(studyId), nodeListResponseSchema);
}

export function fetchNode(studyId: string, nodeId: string): Promise<NodeResponse> {
  return apiFetch(nodePath(studyId, nodeId), nodeResponseSchema);
}

/** `GET /studies/:id/nodes/:nodeId/versions`: a conclusion's immutable versions, newest first. */
export function fetchNodeVersions(
  studyId: string,
  nodeId: string,
): Promise<NodeVersionListResponse> {
  return apiFetch(`${nodePath(studyId, nodeId)}/versions`, nodeVersionListResponseSchema);
}

/**
 * After a conclusion or question action, or an edge change that cleared a conclusion's marker:
 * the node's detail, its history, the Nodes list (markers and warnings are drawn there), and the
 * graph snapshot that reuses the same summaries.
 */
export async function invalidateNodeChange(
  queryClient: QueryClient,
  studyId: string,
  nodeId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: nodeQueryKey(studyId, nodeId) }),
    queryClient.invalidateQueries({ queryKey: nodeVersionsQueryKey(studyId, nodeId) }),
    queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) }),
    invalidateGraph(queryClient, studyId),
  ]);
}

/** `POST /studies/:id/nodes`. `expectedRevision` is the study's. */
export function createNode(
  studyId: string,
  body: CreateNodeRequest,
  idempotencyKey: string,
): Promise<CreateNodeResponse> {
  return apiFetch(nodesPath(studyId), createNodeResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `PATCH /studies/:id/nodes/:nodeId`. `expectedRevision` is the node's. */
export function updateNode(
  studyId: string,
  nodeId: string,
  body: UpdateNodeRequest,
  idempotencyKey: string,
): Promise<NodeMutationResponse> {
  return apiFetch(nodePath(studyId, nodeId), nodeMutationResponseSchema, {
    method: 'PATCH',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `POST /studies/:id/nodes/:nodeId/duplicate` (BIB-61). `expectedRevision` is the study's. */
export function duplicateNode(
  studyId: string,
  nodeId: string,
  body: DuplicateNodeRequest,
  idempotencyKey: string,
): Promise<DuplicateNodeResponse> {
  return apiFetch(`${nodePath(studyId, nodeId)}/duplicate`, duplicateNodeResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `DELETE /studies/:id/nodes/:nodeId` (BIB-31). `expectedRevision` is the node's. */
export function deleteNode(
  studyId: string,
  nodeId: string,
  body: NodeStateRequest,
  idempotencyKey: string,
): Promise<NodeDeleteResponse> {
  return apiFetch(nodePath(studyId, nodeId), nodeDeleteResponseSchema, {
    method: 'DELETE',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `POST /studies/:id/nodes/:nodeId/restore` (BIB-31). `expectedRevision` is the deleted node's. */
export function restoreNode(
  studyId: string,
  nodeId: string,
  body: NodeStateRequest,
  idempotencyKey: string,
): Promise<NodeRestoreResponse> {
  return apiFetch(`${nodePath(studyId, nodeId)}/restore`, nodeRestoreResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** The study's deleted nodes (BIB-31), under the study's key like every node query. */
export function deletedNodesQueryKey(studyId: string) {
  return ['studies', studyId, 'nodes', 'deleted'] as const;
}

export function listDeletedNodes(studyId: string): Promise<DeletedNodeListResponse> {
  return apiFetch(`${nodesPath(studyId)}?state=deleted`, deletedNodeListResponseSchema);
}

export const ESTABLISHED_TEXT = 'Established by me';
export const EVIDENCE_INCOMPLETE_TEXT = 'Evidence incomplete';

/**
 * The status or kind a node shows next to its type, with a conclusion's marker and warning
 * (BIB-30): text, never color alone.
 */
export function nodeStateText(
  node: Pick<NodeSummary, 'status' | 'observationKind' | 'established' | 'evidenceIncomplete'>,
): string | null {
  if (node.status) {
    return [
      NODE_STATUS_NAMES[node.status],
      node.established ? ESTABLISHED_TEXT : null,
      node.evidenceIncomplete ? EVIDENCE_INCOMPLETE_TEXT : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (node.observationKind) {
    // BIB-62: an observation can be "Established by me" too.
    const kind = OBSERVATION_KIND_NAMES[node.observationKind];
    return node.established ? `${kind} · ${ESTABLISHED_TEXT}` : kind;
  }
  return null;
}

const SENTENCE_END = /[.!?…]["'”’)]*$/;

/** Whether text already ends a sentence (with . ! ? or …, maybe before a closing quote). */
export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trimEnd());
}

/** Text (a node label) ending a sentence: no second period when it already ends with one. */
export function endSentence(text: string): string {
  return endsSentence(text) ? text : `${text}.`;
}

/** Text (a node label) as one item of a "; " list: its own final period dropped, never ".;". */
export function listItem(text: string): string {
  return text.trimEnd().replace(/([^.])\.$/, '$1');
}

/**
 * "Thought: Maybe conscience…", as the Notes "Attach to" select names a node; a duplicate
 * Scripture node (BIB-26) says so: "Scripture: Romans 9:1 (duplicate)".
 */
export function nodeOptionText(
  node: Pick<NodeSummary, 'type' | 'label' | 'canonicalNodeId'>,
  max = 80,
): string {
  const suffix = node.canonicalNodeId ? ` ${DUPLICATE_SUFFIX}` : '';
  const text = `${NODE_TYPE_NAMES[node.type]}: ${node.label}`;
  const points = Array.from(text);
  const room = max - Array.from(suffix).length;
  return (points.length > room ? `${points.slice(0, room - 1).join('')}…` : text) + suffix;
}

const DUPLICATE_SUFFIX = '(duplicate)';

/** A study page link that opens with one node selected (BIB-26): its opaque id, never a label. */
export function studyNodeHref(studyId: string, nodeId: string): string {
  return `${studyHref(studyId)}?node=${encodeURIComponent(nodeId)}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatNodeTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}
