import {
  type GraphResponse,
  graphResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type SavePositionsRequest,
  type SavePositionsResponse,
  savePositionsResponseSchema,
} from '@bible-artisan/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';

/**
 * Graph snapshot and layout data access (BIB-28). These are the library-independent domain DTOs:
 * the canvas converts them to React Flow objects (`graph-view.ts`), and only `{nodeId, x, y}`
 * ever goes back. URLs carry opaque ids alone; nothing here touches browser storage.
 */

const studyPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}`;

/** Under the study's key, so refreshing a study refreshes its graph too. */
export function graphQueryKey(studyId: string) {
  return ['studies', studyId, 'graph'] as const;
}

export function fetchGraph(studyId: string): Promise<GraphResponse> {
  return apiFetch(`${studyPath(studyId)}/graph`, graphResponseSchema);
}

/**
 * `PATCH /studies/:id/positions`. `expectedRevision` is the **view** revision. `keepalive` lets a
 * save sent while the page goes away finish without it.
 */
export function savePositions(
  studyId: string,
  body: SavePositionsRequest,
  idempotencyKey: string,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<SavePositionsResponse> {
  return apiFetch(`${studyPath(studyId)}/positions`, savePositionsResponseSchema, {
    method: 'PATCH',
    keepalive,
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** After a node or relationship change elsewhere on the page, so the canvas shows it. */
export function invalidateGraph(queryClient: QueryClient, studyId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: graphQueryKey(studyId) });
}
