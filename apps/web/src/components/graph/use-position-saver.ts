'use client';

import {
  type GraphResponse,
  MAX_POSITIONS_PER_REQUEST,
  type NodePosition,
  type SavePositionsRequest,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError, isRetryable } from '@/lib/api-errors';
import { fetchGraph, graphQueryKey, savePositions } from '@/lib/graph';
import { useGraphViewStore } from '@/lib/graph-store';
import type { XY } from '@/lib/graph-view';

/** PRD section 27: drag positions save 300 ms after the movement ends. */
export const POSITION_SAVE_DEBOUNCE_MS = 300;

/** The small layout indicator, separate from content save state (PRD section 27). */
export type LayoutSaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  /** Not saved: `retry` resends the frozen request (unknown outcome) or the queue. */
  | { state: 'failed' }
  /**
   * A second 409 in a row: another tab keeps moving nodes. The positions stay queued (the next
   * save resends them on the fresh view revision); Reload takes the server's layout instead.
   */
  | { state: 'conflict' }
  /** Every node a save carried was deleted elsewhere, and nothing else is waiting to be saved. */
  | { state: 'removed' };

/** States in which a local position is not (yet) known to be saved: leaving the page warns. */
const UNSAVED_STATES = new Set<LayoutSaveStatus['state']>(['saving', 'failed', 'conflict']);

interface Frozen {
  body: SavePositionsRequest & { positions: NodePosition[] };
  key: string;
}

interface SendOptions {
  /** The page is going away: the request must outlive it (`fetch` keepalive). */
  keepalive?: boolean;
}

const LIFECYCLE_CODES = new Set(['STUDY_ARCHIVED', 'STUDY_TRASHED']);

/**
 * Saves moved positions (BIB-28): the store's pending queue, 300 ms after the last move (or at
 * once for an arrangement, whose nodes always go in one request), at most 100 per request, one
 * request in flight, each against the latest view revision. A request is frozen with its
 * Idempotency-Key and resent verbatim after an unknown outcome. A stale view revision (another tab
 * moved nodes) refetches the graph and resends the same nodes' latest positions once with a new
 * key: positions are the user's latest gesture, so there is nothing to merge; a second stale
 * revision keeps them queued and offers Reload. "Layout saved" is shown only after the server's
 * 200 and only when nothing else is queued. Leaving (unmount, `pagehide`) sends what is queued at
 * once; a save held for Retry or in conflict makes the browser ask before the page goes.
 */
export function usePositionSaver(studyId: string, onLocked: () => void) {
  const store = useGraphViewStore();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LayoutSaveStatus>({ state: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  /** A request whose outcome is unknown: nothing else is sent until it is resent (Retry). */
  const frozen = useRef<Frozen | null>(null);

  const viewRevision = useCallback(
    () => queryClient.getQueryData<GraphResponse>(graphQueryKey(studyId))?.viewRevision ?? 1,
    [queryClient, studyId],
  );

  const refetchGraph = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: graphQueryKey(studyId),
        queryFn: () => fetchGraph(studyId),
        staleTime: 0,
      }),
    [queryClient, studyId],
  );

  const acknowledge = useCallback(
    (revision: number, saved: readonly NodePosition[]) => {
      queryClient.setQueryData<GraphResponse>(graphQueryKey(studyId), (old) => {
        if (!old) return old;
        const next = new Map(old.positions.map((p) => [p.nodeId, p]));
        for (const p of saved) next.set(p.nodeId, { nodeId: p.nodeId, x: p.x, y: p.y });
        return {
          ...old,
          viewRevision: Math.max(old.viewRevision, revision),
          positions: [...next.values()].sort((a, b) =>
            a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
          ),
        };
      });
    },
    [queryClient, studyId],
  );

  // `flush` and `send` call each other; a ref breaks the cycle without re-creating either.
  const flushRef = useRef<(options?: SendOptions) => Promise<void>>(async () => {});

  const send = useCallback(
    async (first: Frozen, { keepalive = false }: SendOptions = {}): Promise<void> => {
      let request = first;
      let conflictRetried = false;
      // At most two passes: the request, then one resend after a stale view revision.
      for (;;) {
        inFlight.current = true;
        setStatus({ state: 'saving' });
        try {
          const response = await savePositions(studyId, request.body, request.key, { keepalive });
          inFlight.current = false;
          acknowledge(response.viewRevision, request.body.positions);
          if (store.getState().pendingIds.size > 0) await flushRef.current();
          else setStatus({ state: 'saved' });
          return;
        } catch (error) {
          inFlight.current = false;
          const ids = request.body.positions.map((p) => p.nodeId);
          if (error instanceof ApiError && error.status === 409) {
            if (conflictRetried) {
              // Still unsaved: queued for the next save (on a fresh revision) until Reload.
              store.getState().requeue(ids);
              setStatus({ state: 'conflict' });
              return;
            }
            try {
              await refetchGraph();
            } catch {
              store.getState().requeue(ids);
              setStatus({ state: 'failed' });
              return;
            }
            const local = store.getState().localPositions;
            const positions = request.body.positions.map((p) => ({ ...p, ...local[p.nodeId] }));
            request = {
              body: { expectedRevision: viewRevision(), positions },
              key: crypto.randomUUID(),
            };
            conflictRetried = true;
            continue;
          }
          if (error instanceof ApiError && error.status === 404) {
            // A node is gone (or the study is): drop what no longer exists and resend the rest.
            try {
              const graph = await refetchGraph();
              const live = new Set(graph.nodes.map((node) => node.id));
              const gone = ids.filter((id) => !live.has(id));
              store.getState().forget(gone);
              store.getState().requeue(ids.filter((id) => live.has(id)));
              if (gone.length > 0) {
                if (store.getState().pendingIds.size > 0) await flushRef.current();
                else setStatus({ state: 'removed' });
                return;
              }
            } catch {
              store.getState().requeue(ids);
            }
            setStatus({ state: 'failed' });
            return;
          }
          if (
            error instanceof ApiError &&
            error.status === 422 &&
            LIFECYCLE_CODES.has(error.code ?? '')
          ) {
            setStatus({ state: 'idle' });
            onLocked();
            return;
          }
          if (isRetryable(classifyError(error))) frozen.current = request;
          else store.getState().requeue(ids);
          setStatus({ state: 'failed' });
          return;
        }
      }
    },
    [acknowledge, onLocked, refetchGraph, store, studyId, viewRevision],
  );

  const flush = useCallback(
    async (options: SendOptions = {}) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (inFlight.current || frozen.current) return;
      const ids = store.getState().takePending(MAX_POSITIONS_PER_REQUEST);
      if (ids.length === 0) return;
      const local = store.getState().localPositions;
      const positions = ids.flatMap((id) => {
        const p = local[id];
        return p ? [{ nodeId: id, x: p.x, y: p.y }] : [];
      });
      if (positions.length === 0) return;
      await send(
        { body: { expectedRevision: viewRevision(), positions }, key: crypto.randomUUID() },
        options,
      );
    },
    [send, store, viewRevision],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Leaving: the page (pagehide) or the study (unmount, a route change) sends the queued moves
  // now rather than dropping them with the debounce. The request starts synchronously, with
  // keepalive so it outlives the page.
  useEffect(() => {
    const leave = () => void flushRef.current({ keepalive: true });
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);

  // Unacknowledged layout (a save in flight, held for Retry, or in conflict): the browser asks
  // before the page goes, as the note editor does (PRD section 27).
  const unsaved = UNSAVED_STATES.has(status.state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  /**
   * Places nodes and queues their save: debounced after a move; at once for an arrangement,
   * whose nodes go together in one request (after any earlier moves that don't fit with them).
   */
  const save = useCallback(
    (positions: Record<string, XY>, { arrangement = false }: { arrangement?: boolean } = {}) => {
      store.getState().move(positions, { together: arrangement });
      if (timer.current) clearTimeout(timer.current);
      if (arrangement) {
        void flush();
        return;
      }
      timer.current = setTimeout(() => void flush(), POSITION_SAVE_DEBOUNCE_MS);
    },
    [flush, store],
  );

  /** Resends the frozen request verbatim (same key), or the queue. */
  const retry = useCallback(() => {
    const request = frozen.current;
    frozen.current = null;
    if (request) void send(request);
    else void flush();
  }, [flush, send]);

  /** Takes the server's layout: forgets local positions and refetches. */
  const reload = useCallback(async () => {
    frozen.current = null;
    store.getState().forget(Object.keys(store.getState().localPositions));
    setStatus({ state: 'idle' });
    await queryClient.invalidateQueries({ queryKey: graphQueryKey(studyId) });
  }, [queryClient, store, studyId]);

  return { status, save, retry, reload };
}
