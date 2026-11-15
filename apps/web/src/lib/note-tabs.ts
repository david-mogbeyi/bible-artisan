import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { noteListsKey, noteQueryKey, noteVersionsQueryKey } from './notes';

/**
 * Cross-tab coordination for open notes (BIB-37; PRD section 27). Over a `BroadcastChannel` this
 * tab says which note it has open and which saves the server acknowledged; other tabs warn that
 * the note is open elsewhere and refetch it. Messages carry opaque ids and revisions only, never
 * note text. Server revision checks stay authoritative (other devices never hear any of this).
 */
export const NOTE_TABS_CHANNEL = 'bible-artisan:notes';

type NoteTabMessage =
  | { type: 'open'; tabId: string; noteId: string }
  | { type: 'here'; tabId: string; noteId: string; to: string }
  | { type: 'closed'; tabId: string; noteId: string }
  | { type: 'saved'; tabId: string; studyId: string; noteId: string; revision: number };

const isMessage = (data: unknown): data is NoteTabMessage =>
  typeof data === 'object' &&
  data !== null &&
  typeof (data as { type?: unknown }).type === 'string' &&
  typeof (data as { tabId?: unknown }).tabId === 'string' &&
  typeof (data as { noteId?: unknown }).noteId === 'string';

/**
 * For one open note: whether another tab of this browser has it open too, and `announceSaved`
 * to tell other tabs after the server acknowledged a save (they refetch the note and its lists).
 * Without `BroadcastChannel` it reports no other tab and announces nothing.
 */
export function useNoteTabs(
  studyId: string,
  noteId: string,
): { elsewhere: boolean; announceSaved: (revision: number) => void } {
  const queryClient = useQueryClient();
  const [others, setOthers] = useState<ReadonlySet<string>>(new Set());
  const channel = useRef<BroadcastChannel | null>(null);
  const [tabId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const current = new BroadcastChannel(NOTE_TABS_CHANNEL);
    channel.current = current;
    const post = (message: NoteTabMessage) => current.postMessage(message);
    current.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isMessage(message) || message.tabId === tabId || message.noteId !== noteId) return;
      switch (message.type) {
        case 'open':
          setOthers((prev) => new Set(prev).add(message.tabId));
          post({ type: 'here', tabId, noteId, to: message.tabId });
          break;
        case 'here':
          if (message.to === tabId) setOthers((prev) => new Set(prev).add(message.tabId));
          break;
        case 'closed':
          setOthers((prev) => {
            const next = new Set(prev);
            next.delete(message.tabId);
            return next;
          });
          break;
        case 'saved':
          if (message.studyId !== studyId) return;
          void queryClient.invalidateQueries({ queryKey: noteQueryKey(studyId, noteId) });
          void queryClient.invalidateQueries({ queryKey: noteListsKey(studyId) });
          void queryClient.invalidateQueries({ queryKey: noteVersionsQueryKey(studyId, noteId) });
          break;
      }
    };
    post({ type: 'open', tabId, noteId });
    return () => {
      post({ type: 'closed', tabId, noteId });
      current.close();
      channel.current = null;
      setOthers(new Set());
    };
  }, [queryClient, studyId, noteId, tabId]);

  const announceSaved = useCallback(
    (revision: number) => {
      channel.current?.postMessage({
        type: 'saved',
        tabId,
        studyId,
        noteId,
        revision,
      } satisfies NoteTabMessage);
    },
    [tabId, studyId, noteId],
  );

  return { elsewhere: others.size > 0, announceSaved };
}
