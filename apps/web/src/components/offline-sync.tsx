'use client';

import { NOTE_UNCHANGED } from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { saveNote } from '@/lib/notes';
import {
  downloadDrafts,
  dropFailedEntry,
  entryDrafts,
  isNoteClaimed,
  listQueued,
  type QueuedNoteSave,
  replayNoteSave,
  subscribeOfflineQueue,
} from '@/lib/offline-queue';
import { AUTOSAVE_RETRY_DELAYS_MS } from './notes/note-autosave';

export const OFFLINE_SYNC_COPY = {
  waiting: (count: number) =>
    `${count} offline note ${count === 1 ? 'edit is' : 'edits are'} waiting to sync.`,
  failed: (count: number) =>
    `${count} offline note ${count === 1 ? 'edit' : 'edits'} couldn't be synced: the note changed elsewhere or can't take the edit any more. Download to keep a copy.`,
  download: 'Download unsynced drafts',
  discard: "Discard edits that couldn't sync",
} as const;

/**
 * A replay's refusal, by kind: a conflict or a definite 4xx is final (kept for download); the
 * server already holding the content counts as acknowledged; anything else (offline, 5xx, 429, an
 * expired session) is retried later with the same key.
 */
function definite(error: unknown): 'conflict' | 'refused' | 'unchanged' | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409) return 'conflict';
  if (error.status === 422 && error.code === NOTE_UNCHANGED) return 'unchanged';
  if (error.status === 401 || error.status === 429 || error.status >= 500) return null;
  return error.status >= 400 ? 'refused' : null;
}

/**
 * Replays the signed-in account's offline queue (BIB-36; PRD section 27) on load, when the
 * connection comes back and when the tab regains focus, skipping notes an editor in this tab has
 * open (it sends its own). Unknown outcomes back off at about 1, 2, 4, 8 and 30 seconds, then
 * wait for the next reconnect. Shows what is still waiting, and what couldn't sync, with a
 * download so nothing is lost silently.
 */
export function OfflineSync({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<QueuedNoteSave[]>([]);
  useEffect(() => {
    // One replay loop per mounted account: never two passes at once, a request during a pass
    // runs one more pass after it.
    let live = true;
    let running = false;
    let again = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      const queued = await listQueued(accountId);
      if (live) setEntries(queued);
    };

    const replayAll = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      running = true;
      let retry = false;
      try {
        for (const entry of await listQueued(accountId)) {
          if (!live) return;
          if (entry.failed || isNoteClaimed(entry.noteId)) continue;
          const outcome = await replayNoteSave(
            entry,
            (body, key) => saveNote(entry.studyId, entry.noteId, body, key),
            { isDefinite: definite },
          );
          if (outcome.kind === 'retry') {
            retry = true;
            break;
          }
          // The note's cached copies are refetched: the server's text is what shows next.
          void queryClient.invalidateQueries({ queryKey: ['studies', entry.studyId, 'notes'] });
        }
      } finally {
        running = false;
      }
      if (!live) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const delay = retry ? AUTOSAVE_RETRY_DELAYS_MS[retries] : undefined;
      if (delay !== undefined) {
        retries += 1;
        timer = setTimeout(() => void replayAll(), delay * (0.8 + Math.random() * 0.4));
      } else if (!retry) {
        retries = 0;
      }
      if (again) {
        again = false;
        void replayAll();
      }
    };

    const unsubscribe = subscribeOfflineQueue(() => void refresh());
    void refresh();
    void replayAll();
    const resume = () => {
      retries = 0;
      void replayAll();
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      if (timer !== null) clearTimeout(timer);
    };
  }, [accountId, queryClient]);

  if (entries.length === 0) return null;
  const failed = entries.filter((entry) => entry.failed);
  const waiting = entries.length - failed.length;

  return (
    <section
      aria-label="Offline edits"
      className="fixed inset-x-4 bottom-4 z-50 flex max-w-md flex-col gap-2 rounded border bg-canvas p-3 text-sm shadow sm:right-auto"
    >
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {waiting > 0 ? <p>{OFFLINE_SYNC_COPY.waiting(waiting)}</p> : null}
        {failed.length > 0 ? <p>{OFFLINE_SYNC_COPY.failed(failed.length)}</p> : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => downloadDrafts(entryDrafts(entries))}
          className="text-accent underline"
        >
          {OFFLINE_SYNC_COPY.download}
        </button>
        {failed.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              for (const entry of failed) {
                void dropFailedEntry(entry.id);
              }
            }}
            className="text-accent underline"
          >
            {OFFLINE_SYNC_COPY.discard}
          </button>
        ) : null}
      </div>
    </section>
  );
}
