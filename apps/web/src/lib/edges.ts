import {
  type CreateEdgeRequest,
  type CreateEdgeResponse,
  createEdgeResponseSchema,
  EDGE_PHRASES,
  type Edge,
  type EdgeListResponse,
  edgeListResponseSchema,
  type EdgeMutationResponse,
  edgeMutationResponseSchema,
  type EdgeType,
  IDEMPOTENCY_KEY_HEADER,
  NODE_TYPE_NAMES,
  type StudyNodeType,
  type UpdateEdgeRequest,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Typed relationship data access (BIB-27). Notes travel only in request and response bodies; URLs
 * carry opaque ids alone, and nothing here touches browser storage. Every mutation takes an
 * Idempotency-Key that a retry resends with the identical body. These are domain DTOs; a canvas
 * (BIB-28) converts them to its own view objects.
 */

const edgesPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/edges`;
const edgePath = (studyId: string, edgeId: string) =>
  `${edgesPath(studyId)}/${encodeURIComponent(edgeId)}`;

/** Under the study's key, so refreshing a study refreshes its relationships too. */
export function edgesQueryKey(studyId: string, nodeId: string) {
  return ['studies', studyId, 'edges', nodeId] as const;
}

export function listEdges(studyId: string, nodeId: string): Promise<EdgeListResponse> {
  return apiFetch(
    `${edgesPath(studyId)}?nodeId=${encodeURIComponent(nodeId)}`,
    edgeListResponseSchema,
  );
}

/** `POST /studies/:id/edges`. `expectedRevision` is the study's. */
export function createEdge(
  studyId: string,
  body: CreateEdgeRequest,
  idempotencyKey: string,
): Promise<CreateEdgeResponse> {
  return apiFetch(edgesPath(studyId), createEdgeResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `PATCH /studies/:id/edges/:edgeId`. `expectedRevision` is the edge's. */
export function updateEdge(
  studyId: string,
  edgeId: string,
  body: UpdateEdgeRequest,
  idempotencyKey: string,
): Promise<EdgeMutationResponse> {
  return apiFetch(edgePath(studyId, edgeId), edgeMutationResponseSchema, {
    method: 'PATCH',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `DELETE /studies/:id/edges/:edgeId`. `expectedRevision` is the edge's. */
export function deleteEdge(
  studyId: string,
  edgeId: string,
  body: { expectedRevision: number },
  idempotencyKey: string,
): Promise<EdgeMutationResponse> {
  return apiFetch(edgePath(studyId, edgeId), edgeMutationResponseSchema, {
    method: 'DELETE',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** "this observation": how a sentence names the node whose detail is open. */
export function thisNode(type: StudyNodeType): string {
  return `this ${NODE_TYPE_NAMES[type].toLowerCase()}`;
}

/**
 * A relationship as one sentence, the direction in words (PRD section 12): the source, the type's
 * outgoing phrase, the target. `source` / `target` are already-worded names ("This observation",
 * "Conclusion: …"). Two-way types read the same whichever node comes first.
 */
export function edgeSentence(source: string, type: EdgeType, target: string): string {
  const sentence = `${source} ${EDGE_PHRASES[type].outgoing} ${target}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The other endpoint of `edge`, seen from `nodeId`. */
export function otherEnd(edge: Pick<Edge, 'sourceNodeId' | 'targetNodeId'>, nodeId: string) {
  return edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
}
