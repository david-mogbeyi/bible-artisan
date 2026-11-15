import {
  type NoteDocument,
  type NoteMutationResponse,
  notePlainText,
  type UpdateNoteRequest,
} from '@bible-artisan/contracts';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

/**
 * The bounded offline queue (BIB-36; PRD section 27, FR-SAVE-002/004). When a note edit can't
 * reach the server, its request is kept in IndexedDB so a reload or a closed tab doesn't lose it,
 * then replayed once through the normal pipeline: the stored request keeps its Idempotency-Key
 * and `expectedRevision`, so a replay of a save that already committed returns the stored answer
 * (the server keeps receipts seven days) and a stale one gets 409 rather than overwriting.
 *
 * Bounded: entries expire after seven days (the receipts' lifetime), a study holds at most 100
 * and an account at most 5 MB. A full queue refuses the entry and the caller blocks editing,
 * offering the draft as a download, rather than losing it. Entries carry the account id: another
 * account signed in on the same browser never sees or replays them, and sign-out and account
 * deletion delete the whole database.
 *
 * Nothing here logs content. Every call is best effort: without IndexedDB (private mode, tests)
 * the queue is simply unavailable and editing keeps its in-memory behaviour.
 */

export const OFFLINE_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_QUEUE_MAX_PER_STUDY = 100;
export const OFFLINE_QUEUE_MAX_BYTES = 5 * 1024 * 1024;

const DB_NAME = 'bible-artisan-offline';
const STORE = 'commands';

/** A note save request, frozen with its key until its outcome is known. */
export interface QueuedAttempt {
  key: string;
  body: UpdateNoteRequest;
}

/**
 * One note's unacknowledged work: the request to (re)send first, then any later content, which
 * is sent from the revision that request returns. One entry per note, rewritten as the user
 * types (unsent edits coalesce), so a study's count is the number of notes waiting.
 */
export interface QueuedNoteSave {
  /** `note:<noteId>`. */
  id: string;
  kind: 'note';
  accountId: string;
  studyId: string;
  noteId: string;
  /** When this note first queued (expiry counts from here). */
  queuedAt: number;
  /** The revision `draft` is based on when there is no `attempt`. */
  revision: number;
  attempt: QueuedAttempt | null;
  draft: NoteDocument | null;
  /** Set when a replay was refused (a conflict or a definite 4xx): kept for download only. */
  failed?: 'conflict' | 'refused';
  bytes: number;
}

interface OfflineDb extends DBSchema {
  commands: { key: string; value: QueuedNoteSave };
}

export type QueueWrite = 'queued' | 'full' | 'unavailable';

let dbPromise: Promise<IDBPDatabase<OfflineDb>> | null = null;

function db(): Promise<IDBPDatabase<OfflineDb>> | null {
  if (typeof indexedDB === 'undefined') return null;
  dbPromise ??= openDB<OfflineDb>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE, { keyPath: 'id' });
    },
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

const listeners = new Set<() => void>();

/** Called after every change to the queue (for the pending-edits notice). */
export function subscribeOfflineQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export const noteEntryId = (noteId: string): string => `note:${noteId}`;

const byteSize = (entry: Omit<QueuedNoteSave, 'bytes'>): number =>
  new Blob([JSON.stringify(entry)]).size;

const expired = (entry: QueuedNoteSave, now: number): boolean =>
  now - entry.queuedAt > OFFLINE_QUEUE_MAX_AGE_MS;

/** Every live entry (expired ones are deleted on the way). */
async function allEntries(database: IDBPDatabase<OfflineDb>): Promise<QueuedNoteSave[]> {
  const now = Date.now();
  const entries = await database.getAll(STORE);
  const stale = entries.filter((entry) => expired(entry, now));
  if (stale.length > 0) {
    const tx = database.transaction(STORE, 'readwrite');
    await Promise.all([...stale.map((entry) => tx.store.delete(entry.id)), tx.done]);
  }
  return entries.filter((entry) => !expired(entry, now));
}

/** This account's queued entries, oldest first. Empty when IndexedDB is unavailable. */
export async function listQueued(accountId: string): Promise<QueuedNoteSave[]> {
  const open = db();
  if (!open) return [];
  try {
    const entries = await allEntries(await open);
    return entries
      .filter((entry) => entry.accountId === accountId)
      .sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

/** This note's queued entry, if any. */
export async function getQueuedNote(noteId: string): Promise<QueuedNoteSave | null> {
  const open = db();
  if (!open) return null;
  try {
    const entry = await (await open).get(STORE, noteEntryId(noteId));
    return entry && !expired(entry, Date.now()) ? entry : null;
  } catch {
    return null;
  }
}

export interface QueueNoteInput {
  accountId: string;
  studyId: string;
  noteId: string;
  revision: number;
  attempt: QueuedAttempt | null;
  draft: NoteDocument | null;
}

/**
 * Writes (or rewrites) a note's entry. Refuses with `full` when it would put the study over 100
 * entries or the account over 5 MB; the existing entry for this note, if any, is replaced, so it
 * doesn't count against its own rewrite.
 */
export async function queueNoteSave(input: QueueNoteInput): Promise<QueueWrite> {
  const open = db();
  if (!open) return 'unavailable';
  try {
    const database = await open;
    const id = noteEntryId(input.noteId);
    const entries = await allEntries(database);
    const previous = entries.find((entry) => entry.id === id);
    const others = entries.filter((entry) => entry.id !== id);
    const base = {
      id,
      kind: 'note' as const,
      accountId: input.accountId,
      studyId: input.studyId,
      noteId: input.noteId,
      queuedAt: previous?.queuedAt ?? Date.now(),
      revision: input.revision,
      attempt: input.attempt,
      draft: input.draft,
    };
    const entry: QueuedNoteSave = { ...base, bytes: byteSize(base) };
    const studyCount = others.filter((other) => other.studyId === input.studyId).length + 1;
    const accountBytes =
      others
        .filter((other) => other.accountId === input.accountId)
        .reduce((sum, other) => sum + other.bytes, 0) + entry.bytes;
    if (studyCount > OFFLINE_QUEUE_MAX_PER_STUDY || accountBytes > OFFLINE_QUEUE_MAX_BYTES) {
      return 'full';
    }
    await database.put(STORE, entry);
    changed();
    return 'queued';
  } catch {
    return 'unavailable';
  }
}

/**
 * Deletes a note's entry. With `onlyKey`, only while the entry still holds that request (or, for
 * `null`, no request): a newer write from an open editor is never removed by an older replay.
 */
export async function dropQueuedNote(noteId: string, onlyKey?: string | null): Promise<void> {
  const open = db();
  if (!open) return;
  try {
    const database = await open;
    const tx = database.transaction(STORE, 'readwrite');
    const entry = await tx.store.get(noteEntryId(noteId));
    if (entry && (onlyKey === undefined || (entry.attempt?.key ?? null) === onlyKey)) {
      await tx.store.delete(entry.id);
    }
    await tx.done;
    if (entry) changed();
  } catch {
    // Best effort: the entry expires on its own.
  }
}

/** Rewrites an entry in place (a replay's progress or outcome). */
async function updateEntry(entry: QueuedNoteSave): Promise<void> {
  const open = db();
  if (!open) return;
  const { bytes: _bytes, ...rest } = entry;
  await (await open).put(STORE, { ...rest, bytes: byteSize(rest) });
  changed();
}

/**
 * Deletes every queued entry, whichever account it belongs to: sign-out and account deletion
 * (PRD section 27: a shared browser must not expose one account's private data to the next).
 */
export async function clearOfflineQueue(): Promise<void> {
  const open = db();
  if (!open) return;
  try {
    await (await open).clear(STORE);
    changed();
  } catch {
    // Best effort.
  }
}

/** Note ids an editor in this tab currently owns: the background replay leaves them alone. */
const claimed = new Map<string, number>();

export function claimNote(noteId: string): () => void {
  claimed.set(noteId, (claimed.get(noteId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (claimed.get(noteId) ?? 1) - 1;
    if (count <= 0) claimed.delete(noteId);
    else claimed.set(noteId, count);
  };
}

export const isNoteClaimed = (noteId: string): boolean => claimed.has(noteId);

export type ReplayOutcome =
  /** Everything was acknowledged; the entry is gone. */
  | { kind: 'synced'; response: NoteMutationResponse | null }
  /** Unknown outcome (offline, 5xx, 429, 401): kept, frozen with its key, for the next try. */
  | { kind: 'retry' }
  /** A conflict or a definite refusal: kept, marked, for download. */
  | { kind: 'failed' };

/**
 * Replays one entry: resends its frozen request with the same key, then sends any later draft
 * from the revision that returned, with a new key written to the entry before it is sent. Each
 * request therefore applies at most once, however often this runs.
 */
export async function replayNoteSave(
  start: QueuedNoteSave,
  send: (body: UpdateNoteRequest, key: string) => Promise<NoteMutationResponse>,
  options: {
    isDefinite: (error: unknown) => 'conflict' | 'refused' | 'unchanged' | null;
    newKey?: () => string;
  },
): Promise<ReplayOutcome> {
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  let entry = start;
  let last: NoteMutationResponse | null = null;
  let lastKey: string | null = entry.attempt?.key ?? null;
  for (;;) {
    if (entry.attempt === null) {
      if (entry.draft === null) break;
      entry = {
        ...entry,
        attempt: {
          key: newKey(),
          body: { expectedRevision: entry.revision, content: entry.draft },
        },
        draft: null,
      };
      await updateEntry(entry);
    }
    const attempt: QueuedAttempt = entry.attempt as QueuedAttempt;
    lastKey = attempt.key;
    let revision: number;
    try {
      last = await send(attempt.body, attempt.key);
      revision = last.revision;
    } catch (error) {
      const definite = options.isDefinite(error);
      if (definite === null) return { kind: 'retry' };
      if (definite !== 'unchanged') {
        await updateEntry({ ...entry, failed: definite });
        return { kind: 'failed' };
      }
      // The server already holds this content at the expected revision.
      revision = attempt.body.expectedRevision;
    }
    const sentContent = attempt.body.content;
    const draftDiffers =
      entry.draft !== null &&
      (sentContent === undefined || JSON.stringify(entry.draft) !== JSON.stringify(sentContent));
    entry = { ...entry, attempt: null, revision, draft: draftDiffers ? entry.draft : null };
    if (entry.draft === null) break;
    await updateEntry(entry);
  }
  await dropQueuedNote(start.noteId, lastKey);
  return { kind: 'synced', response: last };
}

/**
 * Saves queued drafts as a JSON file in the browser's downloads (FR-SAVE-004: a full queue or
 * sign-out offers the draft rather than losing it). Each draft carries its plain text and the
 * rich-text document; nothing leaves the browser.
 */
export function downloadDrafts(
  drafts: { studyId: string; noteId: string; text: string; content: unknown }[],
): void {
  const file = {
    exportedAt: new Date().toISOString(),
    drafts: drafts.map((draft) => ({
      studyId: draft.studyId,
      noteId: draft.noteId,
      text: draft.text,
      content: draft.content,
    })),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bible-artisan-unsynced-drafts.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Queued entries as downloadable drafts: the newest content each holds. */
export function entryDrafts(
  entries: readonly QueuedNoteSave[],
): { studyId: string; noteId: string; text: string; content: NoteDocument }[] {
  return entries.flatMap((entry) => {
    const content = entry.draft ?? entry.attempt?.body.content ?? null;
    return content
      ? [{ studyId: entry.studyId, noteId: entry.noteId, text: notePlainText(content), content }]
      : [];
  });
}
