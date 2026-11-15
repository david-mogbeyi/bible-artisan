'use client';

import { STUDY_ARCHIVED, STUDY_TRASHED } from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError, isRetryable } from '@/lib/api-errors';
import { invalidateLibrary } from '@/lib/studies';
import {
  inverseOf,
  performUndoAction,
  UndoRevisionUnknownError,
  UndoTargetGoneError,
  useUndo,
  useUndoStore,
} from '@/lib/undo';

export const UNDO_COPY = {
  undid: (label: string) => `Undid: ${label}.`,
  redid: (label: string) => `Redid: ${label}.`,
  conflict: (label: string) =>
    `“${label}” can’t be undone here: it changed somewhere else since. Nothing was overwritten. Check it and change it by hand if you still want to.`,
  untracked: (label: string) =>
    `“${label}” can’t be undone here: this tab lost track of its version. Nothing was changed or overwritten. Check it and change it by hand if you still want to.`,
  gone: (label: string) => `“${label}” can’t be reversed: it is no longer there.`,
  refused: (label: string) => `“${label}” can’t be reversed now, so nothing changed.`,
  locked: 'This study is archived or in the trash, so nothing can be undone.',
  unknown: "Couldn't confirm the change. Press the button again to retry; it won't apply twice.",
} as const;

type Outcome = { text: string; alert: boolean };

/**
 * Undo / Redo (BIB-63) for the study page: two labelled buttons, keyboard reachable in tab order,
 * that name the command they reverse ("Undo: Add observation"); the result is announced as text.
 * A refusal drops the command and says why; an unknown outcome keeps it (with its request key)
 * so the next press retries safely.
 */
export function UndoControls({ studyId, editable }: { studyId: string; editable: boolean }) {
  const store = useUndoStore();
  const queryClient = useQueryClient();
  const nextUndo = useUndo((s) => s.undo.at(-1) ?? null);
  const nextRedo = useUndo((s) => s.redo.at(-1) ?? null);
  const busy = useUndo((s) => s.busy);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (!store || !editable) return null;

  async function step(from: 'undo' | 'redo') {
    if (!store) return;
    const state = store.getState();
    const entry = state[from].at(-1);
    if (!entry || state.busy) return;
    const key = entry.key ?? crypto.randomUUID();
    state.setBusy(true);
    setOutcome(null);
    try {
      const revisions = await performUndoAction(studyId, entry.action, state.revisions, key);
      store
        .getState()
        .settle(from, { label: entry.label, action: inverseOf(entry.action) }, revisions);
      setOutcome({
        text: from === 'undo' ? UNDO_COPY.undid(entry.label) : UNDO_COPY.redid(entry.label),
        alert: false,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['studies', studyId] }),
        invalidateLibrary(queryClient),
      ]);
    } catch (error) {
      if (
        !(error instanceof UndoTargetGoneError) &&
        !(error instanceof UndoRevisionUnknownError) &&
        isRetryable(classifyError(error))
      ) {
        store.getState().keepKey(from, key);
        setOutcome({ text: UNDO_COPY.unknown, alert: true });
        return;
      }
      store.getState().settle(from, null, {});
      setOutcome({ text: refusalText(error, entry.label), alert: true });
      void queryClient.invalidateQueries({ queryKey: ['studies', studyId] });
    } finally {
      store.getState().setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Undo and redo" className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-disabled={!nextUndo || busy}
          onClick={() => void step('undo')}
          className="rounded border border-muted px-2 py-1 aria-disabled:opacity-50"
        >
          {nextUndo ? `Undo: ${nextUndo.label}` : 'Undo'}
        </button>
        <button
          type="button"
          aria-disabled={!nextRedo || busy}
          onClick={() => void step('redo')}
          className="rounded border border-muted px-2 py-1 aria-disabled:opacity-50"
        >
          {nextRedo ? `Redo: ${nextRedo.label}` : 'Redo'}
        </button>
      </div>
      <p role={outcome?.alert ? 'alert' : 'status'} aria-live="polite" className="text-sm">
        {outcome?.text ?? ''}
      </p>
    </div>
  );
}

function refusalText(error: unknown, label: string): string {
  if (error instanceof UndoTargetGoneError) return UNDO_COPY.gone(label);
  if (error instanceof UndoRevisionUnknownError) return UNDO_COPY.untracked(label);
  if (!(error instanceof ApiError)) return UNDO_COPY.refused(label);
  if (error.status === 409) return UNDO_COPY.conflict(label);
  if (error.status === 404) return UNDO_COPY.gone(label);
  if (error.code === STUDY_ARCHIVED || error.code === STUDY_TRASHED) return UNDO_COPY.locked;
  return UNDO_COPY.refused(label);
}
