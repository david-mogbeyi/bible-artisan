'use client';

import type { PaneName, SaveViewStateRequest } from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useGraphView } from '@/lib/graph-store';
import { resumeQueryKey } from '@/lib/resume';
import { patchViewState } from '@/lib/view-revision';

/** Selection, branch, viewport and pane changes settle for this long before one save. */
export const VIEW_STATE_DEBOUNCE_MS = 800;

type Patch = Omit<SaveViewStateRequest, 'expectedRevision'>;

/**
 * Saves the study page's context (BIB-34) so Home's "Resume from last point" and the next visit
 * can restore it: the selected node and the branch shown alone, the canvas viewport the user
 * panned or zoomed to, and the open pane (the narrow layout's tab). Renders nothing. Only changes
 * the user makes are saved, never the state the page opened with (opening is restoration, not
 * activity).
 *
 * Changes made within the debounce are merged into one request (each field keeps its latest
 * value). Saves go through the study's view-revision lane (`patchViewState`), the one position
 * saves use too, so a save right after a drag waits for it and sends the revision it left: this
 * tab never conflicts with itself. A 409 from another tab is resent once on the current revision.
 * Leaving (unmount, `pagehide`) sends what is still waiting at once. Best effort: a failed save
 * never interrupts study, and it never moves the study's last activity.
 */
export function ViewStateSaver({
  studyId,
  active,
  openedNodeId,
  openedBranchId,
  openPane = null,
}: {
  studyId: string;
  active: boolean;
  /**
   * The page URL's `?node=` (else the saved selection, known once the view state loads) and
   * `?branch=`: what the page opened with (a restore).
   */
  openedNodeId: string | null;
  openedBranchId: string | null;
  /** The pane the user opened (null until they pick one): saved as the only open pane. */
  openPane?: PaneName | null;
}) {
  const queryClient = useQueryClient();
  const selectedNodeId = useGraphView((state) => state.selectedNodeIds.at(-1) ?? null);
  const soloBranchId = useGraphView((state) => state.soloBranchId);
  const viewport = useGraphView((state) => state.viewport);
  const opened = useRef({ selectedNodeId: openedNodeId, soloBranchId: openedBranchId });
  const contextChanged = useRef(false);
  // The saved selection arrives after the first render: until the user changes the context,
  // restoring it is still opening, not a change to save.
  useEffect(() => {
    if (!contextChanged.current)
      opened.current = { ...opened.current, selectedNodeId: openedNodeId };
  }, [openedNodeId]);
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    (keepalive: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const patch = pending.current;
      pending.current = {};
      if (Object.keys(patch).length === 0) return;
      patchViewState(queryClient, studyId, patch, { keepalive }).then(
        () => void queryClient.invalidateQueries({ queryKey: resumeQueryKey(studyId) }),
        () => undefined,
      );
    },
    [queryClient, studyId],
  );

  const queue = useCallback(
    (patch: Patch) => {
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(false), VIEW_STATE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    if (!active) return;
    if (!contextChanged.current) {
      const start = opened.current;
      // Nothing selected yet is the page still restoring `?node=` (the Nodes list selects it once
      // it loads), not a change.
      const sameNode = selectedNodeId === null || selectedNodeId === start.selectedNodeId;
      if (sameNode && start.soloBranchId === soloBranchId) return;
      // Once changed, every later value is the user's.
      contextChanged.current = true;
    }
    queue({ selectedNodeId, activeBranchId: soloBranchId });
  }, [active, queue, selectedNodeId, soloBranchId]);

  useEffect(() => {
    if (!active || viewport === null) return;
    queue({ viewport });
  }, [active, queue, viewport]);

  useEffect(() => {
    if (!active || openPane === null) return;
    queue({ panes: { [openPane]: true } });
  }, [active, openPane, queue]);

  // Leaving: the page (pagehide) or the study (unmount) sends what is waiting now, with keepalive
  // so it outlives the page, rather than dropping it with the debounce.
  useEffect(() => {
    const leave = () => flush(true);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [flush]);

  return null;
}
