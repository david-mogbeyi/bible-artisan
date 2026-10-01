'use client';

import {
  LIFECYCLE_TRANSITION_INVALID,
  STUDY_ARCHIVED,
  STUDY_TRASH_RETENTION_DAYS,
  STUDY_TRASHED,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { ApiError } from '@/lib/api-client';
import {
  changeStudyLifecycle,
  formatPurgeDate,
  invalidateLibrary,
  type StudyLifecycleChange,
  studyQueryKey,
} from '@/lib/studies';

export const ARCHIVED_BANNER = 'Archived. This study is read-only until you unarchive it.';
export const CHANGED_ELSEWHERE = 'This study changed elsewhere. Reload to see the latest.';
export const STATE_CHANGED_ELSEWHERE =
  "This study's status changed elsewhere. Reload to see the latest.";
export const UNSAVED_EDITS_BLOCK =
  'Save or discard your changes to this study before archiving it or moving it to trash.';

/** Said in the polite status region once the server has committed the change. */
const DONE: Record<StudyLifecycleChange, string> = {
  archive: 'Study archived. It is read-only until you unarchive it.',
  unarchive: 'Study unarchived. You can edit it again.',
  trash: 'Study moved to trash.',
  restore: 'Study restored.',
};

const LIFECYCLE_CODES: ReadonlySet<string> = new Set([
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  LIFECYCLE_TRANSITION_INVALID,
]);

const CHANGE_COPY: ProblemCopy = {
  notFound: "This study isn't available any more.",
  refused: "Couldn't change the study.",
  // A lost response may still have committed: Retry reuses the key, so it never applies twice.
  unavailable: "Couldn't confirm the change was saved. Retry won't apply it twice.",
};

const RELOAD_COPY: ProblemCopy = {
  notFound: "This study isn't available any more.",
  refused: "Couldn't load the latest study.",
  unavailable: "Couldn't load the latest study.",
};

/** One lifecycle request, frozen once sent so a retry resends it with the same key. */
interface Attempt {
  change: StudyLifecycleChange;
  expectedRevision: number;
  key: string;
}

/**
 * Archive, unarchive, move to trash and restore on a study's page (BIB-22, FR-STUDY-005/006).
 *
 * - Active: Archive and Move to trash. Archived: a read-only banner, Unarchive and Move to trash.
 *   Trashed: a banner with the permanent deletion date, and Restore.
 * - Move to trash asks first in a modal dialog: focus starts on Cancel, and Cancel or Escape
 *   closes it and returns focus to the button that opened it, changing nothing.
 * - Each change is sent with the study's revision and an Idempotency-Key. Nothing changes on
 *   screen until the server's 200: then the study's cache takes the answer, every library listing
 *   is marked stale, the result is announced, and focus moves to the new state's first action.
 * - Errors are told by code, never by the server's message: a 409, or a 422 lifecycle code, means
 *   the study changed elsewhere and offers Reload; a 404 shows the page's unavailable state; an
 *   unknown outcome (network, 5xx) offers Retry, which resends the identical request.
 * - Buttons stay focusable while a request runs (`aria-disabled`), and ignore presses.
 * - Archive and Move to trash would unmount the editor, so while it holds unsaved work
 *   (`unsavedEdits`: a changed draft, or a save in flight or with an unknown outcome) they are
 *   blocked the same way, described by a visible note saying to save or discard first. Nothing
 *   is ever discarded silently.
 */
export function StudyLifecycleActions({
  study,
  onReload,
  unsavedEdits = false,
}: {
  study: StudyResponse;
  /** Refetches the study into the query cache, rejecting when that fails. */
  onReload: () => Promise<unknown>;
  /** The editor holds unsaved work (see `StudyEditor`'s `onUnsavedChange`). */
  unsavedEdits?: boolean;
}) {
  const queryClient = useQueryClient();
  const blockedNoteId = useId();
  const dialogTitleId = useId();
  const dialogTextId = useId();
  const [announcement, setAnnouncement] = useState('');
  const [stale, setStale] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [problemFrom, setProblemFrom] = useState<'change' | 'reload'>('change');
  const [reloading, setReloading] = useState(false);
  const [alerts, setAlerts] = useState(0);
  // The state a committed change moved the study to, until its buttons are on screen to focus.
  const focusOn = useRef<StudyResponse['lifecycle'] | null>(null);
  // The request in flight, or the last one whose outcome is unknown.
  const frozen = useRef<Attempt | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const trashRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /** A study that is gone (absent, or past its trash window): the page's unavailable state. */
  const showUnavailable = () =>
    queryClient.resetQueries({ queryKey: studyQueryKey(study.id), exact: true });

  const mutation = useMutation({
    mutationFn: (attempt: Attempt) =>
      changeStudyLifecycle(study.id, attempt.change, attempt.expectedRevision, attempt.key),
    onSuccess: (changed, attempt) => {
      if (frozen.current === attempt) frozen.current = null;
      // Set before the cache update below re-renders the page in the new state.
      focusOn.current = changed.lifecycle;
      const { lastEventSequence: _sequence, ...state } = changed;
      // A replayed 200 can be older than what a background refetch already showed.
      queryClient.setQueryData<StudyResponse>(studyQueryKey(study.id), (old) =>
        old && state.revision >= old.revision ? { ...old, ...state } : old,
      );
      // The study leaves one Show listing for another, and its last activity moved.
      void invalidateLibrary(queryClient);
      setAnnouncement(DONE[attempt.change]);
    },
    onError: (error, attempt) => {
      const status = error instanceof ApiError ? error.status : null;
      // A definite refusal wrote nothing, so there is nothing to replay.
      if (status !== null && [400, 404, 409, 422, 428].includes(status)) {
        if (frozen.current === attempt) frozen.current = null;
      }
      if (status === 404) {
        void showUnavailable();
        return;
      }
      if (status === 409) {
        setStale(CHANGED_ELSEWHERE);
      } else if (
        status === 422 &&
        error instanceof ApiError &&
        LIFECYCLE_CODES.has(error.code ?? '')
      ) {
        setStale(STATE_CHANGED_ELSEWHERE);
      } else {
        setProblemFrom('change');
        setProblem(error);
      }
      setAlerts((n) => n + 1);
    },
  });
  const pending = mutation.isPending || reloading;

  useEffect(() => {
    if (alerts > 0) alertRef.current?.focus();
  }, [alerts]);
  // After a committed change the buttons are those of the new state: once the page shows that
  // state (the query cache re-renders it), focus its first action.
  useEffect(() => {
    if (focusOn.current === null || focusOn.current !== study.lifecycle) return;
    focusOn.current = null;
    primaryRef.current?.focus();
  }, [study.lifecycle]);

  // Only an active study has an editor, and only Archive and Move to trash leave it.
  const blocked = unsavedEdits && study.lifecycle === 'active';

  function send(change: StudyLifecycleChange) {
    if (pending) return;
    if (blocked && (change === 'archive' || change === 'trash')) return;
    focusOn.current = null;
    setStale(null);
    setProblem(null);
    const attempt =
      frozen.current?.change === change
        ? frozen.current
        : { change, expectedRevision: study.revision, key: crypto.randomUUID() };
    frozen.current = attempt;
    mutation.mutate(attempt);
  }

  function retry() {
    if (frozen.current) send(frozen.current.change);
  }

  async function reload() {
    if (pending) return;
    setReloading(true);
    try {
      await onReload();
      frozen.current = null;
      setStale(null);
      setProblem(null);
      setAnnouncement('Showing the latest saved study.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        void showUnavailable();
        return;
      }
      setProblemFrom('reload');
      setProblem(error);
      setAlerts((n) => n + 1);
    } finally {
      setReloading(false);
    }
  }

  function openTrashDialog() {
    if (pending || blocked) return;
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }

  /** Cancel and Escape: nothing changes, and focus goes back to Move to trash. */
  function closeTrashDialog() {
    dialogRef.current?.close();
    trashRef.current?.focus();
  }

  function confirmTrash() {
    closeTrashDialog();
    send('trash');
  }

  const buttonClass = 'rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60';
  const busy = pending ? true : undefined;
  const leaving = {
    'aria-disabled': pending || blocked ? true : undefined,
    'aria-describedby': blocked ? blockedNoteId : undefined,
  } as const;

  return (
    <section aria-label="Study status" className="flex flex-col gap-3">
      {study.lifecycle === 'archived' ? (
        <p className="rounded border border-accent px-3 py-2">{ARCHIVED_BANNER}</p>
      ) : null}
      {study.lifecycle === 'trashed' && study.purgeAt !== null ? (
        <p className="rounded border border-accent px-3 py-2">
          In trash. It will be permanently deleted on {formatPurgeDate(study.purgeAt)}.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {study.lifecycle === 'active' ? (
          <button
            ref={primaryRef}
            type="button"
            {...leaving}
            onClick={() => send('archive')}
            className={buttonClass}
          >
            Archive
          </button>
        ) : null}
        {study.lifecycle === 'archived' ? (
          <button
            ref={primaryRef}
            type="button"
            aria-disabled={busy}
            onClick={() => send('unarchive')}
            className={buttonClass}
          >
            Unarchive
          </button>
        ) : null}
        {study.lifecycle === 'trashed' ? (
          <button
            ref={primaryRef}
            type="button"
            aria-disabled={busy}
            onClick={() => send('restore')}
            className={buttonClass}
          >
            Restore
          </button>
        ) : (
          <button
            ref={trashRef}
            type="button"
            aria-haspopup="dialog"
            {...leaving}
            onClick={openTrashDialog}
            className={buttonClass}
          >
            Move to trash
          </button>
        )}
      </div>
      {blocked ? (
        <p id={blockedNoteId} className="text-sm">
          {UNSAVED_EDITS_BLOCK}
        </p>
      ) : null}

      <div ref={alertRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {stale ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded border border-accent px-3 py-2"
          >
            <p>{stale}</p>
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => void reload()}
              className={buttonClass}
            >
              Reload
            </button>
          </div>
        ) : null}
        {problem ? (
          <ProblemAlert
            error={problem}
            copy={problemFrom === 'reload' ? RELOAD_COPY : CHANGE_COPY}
            onRetry={problemFrom === 'reload' ? () => void reload() : retry}
          />
        ) : null}
      </div>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      <dialog
        ref={dialogRef}
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogTextId}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeTrashDialog();
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeTrashDialog();
        }}
        className="m-auto max-w-md rounded border border-muted bg-canvas p-6 text-ink backdrop:bg-black/40"
      >
        <h2 id={dialogTitleId} className="font-serif text-2xl">
          Move this study to trash?
        </h2>
        <p id={dialogTextId} className="mt-2">
          You can restore it from Trash for {STUDY_TRASH_RETENTION_DAYS} days. After that it is
          permanently deleted.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={closeTrashDialog} className={buttonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmTrash}
            className="rounded bg-accent px-3 py-1 text-canvas"
          >
            Move to trash
          </button>
        </div>
      </dialog>
    </section>
  );
}
