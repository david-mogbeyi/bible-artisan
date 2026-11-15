'use client';

import type { GraphResponse } from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError } from '@/lib/api-client';
import { graphQueryKey } from '@/lib/graph';
import { useGraphView } from '@/lib/graph-store';
import { resumeQueryKey, saveViewState } from '@/lib/resume';

/** Selection and branch changes settle for this long before one save. */
export const VIEW_STATE_DEBOUNCE_MS = 800;

/**
 * Saves the study page's context (BIB-34): the selected node and the branch shown alone, so Home's
 * "Resume from last point" can restore them. Renders nothing. Only changes the user makes are
 * saved, never the state the page opened with (opening is restoration, not activity). Saves are
 * checked against the **view revision** the graph snapshot carries (shared with position saves);
 * a 409 is resent once on the current view revision, since a view state is the user's own latest
 * choice. Best effort: a failed save never interrupts study, and it never moves the study's last
 * activity.
 */
export function ViewStateSaver({
  studyId,
  active,
  openedNodeId,
  openedBranchId,
}: {
  studyId: string;
  active: boolean;
  /** The page URL's `?node=` and `?branch=`: what the page opened with (a restore). */
  openedNodeId: string | null;
  openedBranchId: string | null;
}) {
  const queryClient = useQueryClient();
  const selectedNodeId = useGraphView((state) => state.selectedNodeIds.at(-1) ?? null);
  const soloBranchId = useGraphView((state) => state.soloBranchId);
  const opened = useRef({ selectedNodeId: openedNodeId, soloBranchId: openedBranchId });
  const changed = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (!changed.current) {
      const start = opened.current;
      // Nothing selected yet is the page still restoring `?node=` (the Nodes list selects it once
      // it loads), not a change.
      const sameNode = selectedNodeId === null || selectedNodeId === start.selectedNodeId;
      if (sameNode && start.soloBranchId === soloBranchId) return;
      // Once changed, every later value is the user's.
      changed.current = true;
    }
    const timer = setTimeout(() => {
      const graph = () => queryClient.getQueryData<GraphResponse>(graphQueryKey(studyId));
      const send = (expectedRevision: number, retry: boolean): void => {
        saveViewState(
          studyId,
          { expectedRevision, selectedNodeId, activeBranchId: soloBranchId },
          crypto.randomUUID(),
        ).then(
          (saved) => {
            queryClient.setQueryData<GraphResponse>(graphQueryKey(studyId), (old) =>
              old
                ? { ...old, viewRevision: Math.max(old.viewRevision, saved.viewState.viewRevision) }
                : old,
            );
            void queryClient.invalidateQueries({ queryKey: resumeQueryKey(studyId) });
          },
          (error: unknown) => {
            if (!retry || !(error instanceof ApiError) || error.status !== 409) return;
            const current = (error.body as { currentRevision?: unknown } | null)?.currentRevision;
            if (typeof current === 'number') send(current, false);
          },
        );
      };
      send(graph()?.viewRevision ?? 1, true);
    }, VIEW_STATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, queryClient, selectedNodeId, soloBranchId, studyId]);

  return null;
}
