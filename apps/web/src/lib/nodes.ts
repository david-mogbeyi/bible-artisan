import {
  type CreateNodeRequest,
  type CreateNodeResponse,
  createNodeResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  NODE_STATUS_NAMES,
  NODE_TYPE_NAMES,
  type NodeListResponse,
  nodeListResponseSchema,
  type NodeMutationResponse,
  nodeMutationResponseSchema,
  type NodeResponse,
  nodeResponseSchema,
  type NodeSummary,
  OBSERVATION_KIND_NAMES,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

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

export function listNodes(studyId: string): Promise<NodeListResponse> {
  return apiFetch(nodesPath(studyId), nodeListResponseSchema);
}

export function fetchNode(studyId: string, nodeId: string): Promise<NodeResponse> {
  return apiFetch(nodePath(studyId, nodeId), nodeResponseSchema);
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

/** The status or kind a node shows next to its type: text, never color alone. */
export function nodeStateText(
  node: Pick<NodeSummary, 'status' | 'observationKind'>,
): string | null {
  if (node.status) return NODE_STATUS_NAMES[node.status];
  if (node.observationKind) return OBSERVATION_KIND_NAMES[node.observationKind];
  return null;
}

/** "Thought: Maybe conscience…", as the Notes "Attach to" select names a node. */
export function nodeOptionText(node: Pick<NodeSummary, 'type' | 'label'>, max = 80): string {
  const text = `${NODE_TYPE_NAMES[node.type]}: ${node.label}`;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatNodeTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}
