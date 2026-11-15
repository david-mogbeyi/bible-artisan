import type {
  GraphResponse,
  ResumeResponse,
  SaveViewStateRequest,
  SaveViewStateResponse,
} from '@bible-artisan/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client';
import { graphQueryKey } from './graph';
import { fetchResume, resumeQueryKey, saveViewState } from './resume';

/**
 * One study's **view revision** (BIB-28, BIB-34) is shared by position saves
 * (`PATCH /positions`) and view-state saves (`PATCH /view-state`). Sent at the same time, both
 * would carry the same `expectedRevision` and the second would 409 against the first: a conflict
 * this tab caused itself. So every view-revision write of a study goes through one lane: each
 * waits for the previous one to settle, then reads the revision the previous one left.
 */
const lanes = new Map<string, Promise<void>>();

/**
 * Runs `write` after every earlier view-revision write of `studyId` has settled. With nothing
 * pending it starts synchronously, so a `pagehide` keepalive request still leaves before the page
 * goes. `write` reads the revision (`currentViewRevision`) inside, never before it is queued.
 */
export function inViewLane<T>(studyId: string, write: () => Promise<T>): Promise<T> {
  const previous = lanes.get(studyId);
  const run = previous ? previous.then(write) : write();
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(studyId, tail);
  void tail.then(() => {
    if (lanes.get(studyId) === tail) lanes.delete(studyId);
  });
  return run;
}

/** Revisions this tab learned of (a save's answer, a 409's `currentRevision`), per query client. */
const learned = new WeakMap<QueryClient, Map<string, number>>();

/** The newest view revision this tab knows: the graph snapshot, the resume read, or a save. */
export function currentViewRevision(queryClient: QueryClient, studyId: string): number {
  return Math.max(
    queryClient.getQueryData<GraphResponse>(graphQueryKey(studyId))?.viewRevision ?? 1,
    queryClient.getQueryData<ResumeResponse>(resumeQueryKey(studyId))?.viewState.viewRevision ?? 1,
    learned.get(queryClient)?.get(studyId) ?? 1,
  );
}

/**
 * True when the tab holds no view revision of the study at all: no graph snapshot, resume read or
 * earlier save. `currentViewRevision` would then guess 1, which is stale for any study whose
 * layout was ever saved (the reader opened on its own, `/bible?study=…`).
 */
function viewRevisionUnknown(queryClient: QueryClient, studyId: string): boolean {
  return (
    queryClient.getQueryData(graphQueryKey(studyId)) === undefined &&
    queryClient.getQueryData(resumeQueryKey(studyId)) === undefined &&
    learned.get(queryClient)?.get(studyId) === undefined
  );
}

/** Records a view revision the server reported, so the next write in the lane sends it. */
export function noteViewRevision(queryClient: QueryClient, studyId: string, revision: number) {
  const known = learned.get(queryClient) ?? new Map<string, number>();
  learned.set(queryClient, known);
  known.set(studyId, Math.max(known.get(studyId) ?? 1, revision));
  queryClient.setQueryData<GraphResponse>(graphQueryKey(studyId), (old) =>
    old && revision > old.viewRevision ? { ...old, viewRevision: revision } : old,
  );
}

function conflictRevision(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const current = (error.body as { currentRevision?: unknown } | null)?.currentRevision;
  return typeof current === 'number' ? current : null;
}

/**
 * Saves part of the view state (a field left out keeps its saved value) in the study's lane, on
 * the newest view revision. When the tab knows no revision yet, it reads the resume state first
 * (one GET instead of a certain 409); a `keepalive` save never waits, so it still leaves before
 * the page goes. A 409 means another tab saved meanwhile: the patch is the user's own latest
 * choice, so it is resent once on the current revision.
 */
export function patchViewState(
  queryClient: QueryClient,
  studyId: string,
  patch: Omit<SaveViewStateRequest, 'expectedRevision'>,
  options: { keepalive?: boolean } = {},
): Promise<SaveViewStateResponse> {
  return inViewLane(studyId, async () => {
    const attempt = (expectedRevision: number) =>
      saveViewState(studyId, { expectedRevision, ...patch }, crypto.randomUUID(), options);
    if (!options.keepalive && viewRevisionUnknown(queryClient, studyId)) {
      // Best effort: should the read fail, the save still goes and a 409 is resent as before.
      await queryClient
        .fetchQuery({
          queryKey: resumeQueryKey(studyId),
          queryFn: () => fetchResume(studyId),
          retry: false,
        })
        .catch(() => undefined);
    }
    let saved: SaveViewStateResponse;
    try {
      saved = await attempt(currentViewRevision(queryClient, studyId));
    } catch (error) {
      const current = conflictRevision(error);
      if (current === null) throw error;
      noteViewRevision(queryClient, studyId, current);
      saved = await attempt(current);
    }
    noteViewRevision(queryClient, studyId, saved.viewState.viewRevision);
    return saved;
  });
}
