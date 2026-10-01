import {
  type CreateNoteRequest,
  type CreateNoteResponse,
  createNoteResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type NoteListResponse,
  noteListResponseSchema,
  type NoteListState,
  type NoteMutationResponse,
  noteMutationResponseSchema,
  type NoteResponse,
  noteResponseSchema,
  type NoteVersionListResponse,
  noteVersionListResponseSchema,
  type NoteVersionResponse,
  noteVersionResponseSchema,
  type UpdateNoteRequest,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Note data access (BIB-23). Note text travels only in request and response bodies; URLs carry
 * opaque ids alone (PRD section 9, NFR-PRIV-001). Every response is parsed with the shared
 * contract schema, so content the browser renders has passed the same allowlist as on the server.
 */

const notesPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}/notes`;
const notePath = (studyId: string, noteId: string) =>
  `${notesPath(studyId)}/${encodeURIComponent(noteId)}`;

/** Under the study's key, so refreshing a study refreshes its notes too. */
export function notesQueryKey(studyId: string, state: NoteListState) {
  return ['studies', studyId, 'notes', 'list', state] as const;
}

export function noteQueryKey(studyId: string, noteId: string) {
  return ['studies', studyId, 'notes', 'detail', noteId] as const;
}

export function noteVersionsQueryKey(studyId: string, noteId: string) {
  return ['studies', studyId, 'notes', 'versions', noteId] as const;
}

/** The prefix of every note list of a study (live and trash). */
export function noteListsKey(studyId: string) {
  return ['studies', studyId, 'notes', 'list'] as const;
}

export function listNotes(studyId: string, state: NoteListState): Promise<NoteListResponse> {
  const query = state === 'trashed' ? '?state=trashed' : '';
  return apiFetch(`${notesPath(studyId)}${query}`, noteListResponseSchema);
}

export function fetchNote(studyId: string, noteId: string): Promise<NoteResponse> {
  return apiFetch(notePath(studyId, noteId), noteResponseSchema);
}

export function listNoteVersions(
  studyId: string,
  noteId: string,
): Promise<NoteVersionListResponse> {
  return apiFetch(`${notePath(studyId, noteId)}/versions`, noteVersionListResponseSchema);
}

export function fetchNoteVersion(
  studyId: string,
  noteId: string,
  versionId: string,
): Promise<NoteVersionResponse> {
  return apiFetch(
    `${notePath(studyId, noteId)}/versions/${encodeURIComponent(versionId)}`,
    noteVersionResponseSchema,
  );
}

/**
 * `POST /studies/:id/notes`. `expectedRevision` is the study's. A retry after an unknown outcome
 * must resend the same body with the same `idempotencyKey`, so a creation that committed but lost
 * its response is replayed instead of creating a second note.
 */
export function createNote(
  studyId: string,
  body: CreateNoteRequest,
  idempotencyKey: string,
): Promise<CreateNoteResponse> {
  return apiFetch(notesPath(studyId), createNoteResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/**
 * `PATCH /studies/:id/notes/:noteId`: an autosave or a checkpoint. Like `updateStudy` (BIB-20), a
 * retry resends the frozen request: the same body (with its `expectedRevision`) and key.
 */
export function saveNote(
  studyId: string,
  noteId: string,
  body: UpdateNoteRequest,
  idempotencyKey: string,
): Promise<NoteMutationResponse> {
  return apiFetch(notePath(studyId, noteId), noteMutationResponseSchema, {
    method: 'PATCH',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** `DELETE …/notes/:noteId` (to the note trash) or `POST …/notes/:noteId/restore`. */
export function changeNoteState(
  studyId: string,
  noteId: string,
  change: 'trash' | 'restore',
  expectedRevision: number,
  idempotencyKey: string,
): Promise<NoteMutationResponse> {
  const path = notePath(studyId, noteId);
  return apiFetch(change === 'trash' ? path : `${path}/restore`, noteMutationResponseSchema, {
    method: change === 'trash' ? 'DELETE' : 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify({ expectedRevision }),
  });
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A note or version timestamp as the UI shows it. */
export function formatNoteTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}
