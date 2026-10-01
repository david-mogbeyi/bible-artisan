'use client';

import {
  type CreateNoteRequest,
  EMPTY_NOTE_DOCUMENT,
  NOTE_LIMIT_EXCEEDED,
  NOTE_TARGET_NOT_FOUND,
  type NoteListState,
  type NoteSummary,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError } from '@/lib/api-errors';
import {
  changeNoteState,
  createNote,
  fetchNote,
  formatNoteTime,
  listNotes,
  noteListsKey,
  noteQueryKey,
  notesQueryKey,
} from '@/lib/notes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { NoteContent } from './note-content';
import { NoteEditor } from './note-editor';

export const NOTES_COPY = {
  empty: 'No notes yet.',
  trashEmpty: 'The note trash is empty.',
  orphanedHelp: 'Its question or passage was deleted. The note is kept here.',
  createConflict:
    'This study changed somewhere else, so the note was not created. Reload, then try again.',
  createUnknown: "Couldn't confirm the note was created. Retry won't create it twice.",
  createTarget: "That question isn't part of this study any more. Reload the study.",
  createLimit: 'This study has the most notes it can hold. Move some to the trash first.',
  createLocked: 'This study is archived or in the trash, so no note was created. Reload to see it.',
  createFailed: "Couldn't create the note.",
  restoreFailed: "Couldn't restore the note. Reload and try again.",
  restoreUnknown: "Couldn't confirm the note was restored. Retry won't do it twice.",
  loadFailed: "Couldn't load the notes.",
  readOnly: 'This study is read-only, so its notes are too.',
} as const;

type Target = 'study' | 'main';

interface FrozenCreate {
  key: string;
  body: CreateNoteRequest;
}

function targetText(note: NoteSummary): string {
  if (!note.target) return 'On this study';
  const label = note.target.label ?? 'a study item';
  return note.target.nodeType === 'question' ? `On the question: ${label}` : `On ${label}`;
}

/**
 * The study's notes (BIB-23; PRD sections 11, 15): the live notes, notes whose question or passage
 * was deleted (orphaned-note review, FR-NOTE-002), and the note trash. New notes attach to the
 * study or its main question. One note is open at a time, in the editor; a read-only study shows
 * its notes without one. Note text appears only in the page, never in the URL or browser storage.
 */
export function NotesPanel({
  study,
  onReload,
  onUnsavedChange,
}: {
  study: StudyResponse;
  onReload: () => Promise<unknown>;
  onUnsavedChange: (unsaved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editable = study.lifecycle === 'active';
  const ids = { target: useId(), trash: useId() };
  const [showTrash, setShowTrash] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>('study');
  const [creating, setCreating] = useState(false);
  const [createProblem, setCreateProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const frozenCreate = useRef<FrozenCreate | null>(null);
  const [restoreProblem, setRestoreProblem] = useState<string | null>(null);
  const frozenRestore = useRef<{ noteId: string; key: string; revision: number } | null>(null);
  const itemButtons = useRef(new Map<string, HTMLButtonElement>());
  const trashToggle = useRef<HTMLButtonElement>(null);
  /** Where focus returns once a closed editor has left the page. */
  const returnFocusTo = useRef<string | null>(null);

  const listOf = (state: NoteListState, enabled = true) => ({
    queryKey: notesQueryKey(study.id, state),
    queryFn: () => listNotes(study.id, state),
    enabled,
  });
  const live = useQuery(listOf('active'));
  const trashed = useQuery(listOf('trashed', showTrash));
  const open = useQuery({
    queryKey: noteQueryKey(study.id, openId ?? ''),
    queryFn: () => fetchNote(study.id, openId ?? ''),
    enabled: openId !== null,
  });

  // Back to the note's list item once its editor closes; to the note trash toggle when the note
  // just went to the trash.
  useEffect(() => {
    if (openId !== null || returnFocusTo.current === null) return;
    (itemButtons.current.get(returnFocusTo.current) ?? trashToggle.current)?.focus();
    returnFocusTo.current = null;
  }, [openId, live.data]);

  const refreshLists = () => queryClient.invalidateQueries({ queryKey: noteListsKey(study.id) });

  async function create(retry = false) {
    if (creating) return;
    if (!retry || frozenCreate.current === null) {
      frozenCreate.current = {
        key: crypto.randomUUID(),
        body: {
          expectedRevision: study.revision,
          content: EMPTY_NOTE_DOCUMENT,
          ...(target === 'main' && study.mainQuestion
            ? { targetNodeId: study.mainQuestion.nodeId }
            : {}),
        },
      };
    }
    const attempt = frozenCreate.current;
    setCreating(true);
    setCreateProblem(null);
    try {
      const created = await createNote(study.id, attempt.body, attempt.key);
      frozenCreate.current = null;
      // Creating a note moved the study's revision: keep the cached study current.
      queryClient.setQueryData<StudyResponse>(studyQueryKey(study.id), (old) =>
        old && created.studyRevision > old.revision
          ? { ...old, revision: created.studyRevision }
          : old,
      );
      void refreshLists();
      void invalidateLibrary(queryClient);
      setFreshId(created.id);
      setOpenId(created.id);
    } catch (error) {
      const definite = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (definite) frozenCreate.current = null;
      const code = error instanceof ApiError ? error.code : undefined;
      setCreateProblem(
        !definite
          ? { text: NOTES_COPY.createUnknown, retry: true }
          : error.status === 409
            ? { text: NOTES_COPY.createConflict, retry: false }
            : code === NOTE_TARGET_NOT_FOUND
              ? { text: NOTES_COPY.createTarget, retry: false }
              : code === NOTE_LIMIT_EXCEEDED
                ? { text: NOTES_COPY.createLimit, retry: false }
                : code === STUDY_ARCHIVED || code === STUDY_TRASHED
                  ? { text: NOTES_COPY.createLocked, retry: false }
                  : { text: NOTES_COPY.createFailed, retry: false },
      );
    } finally {
      setCreating(false);
    }
  }

  async function restore(note: NoteSummary) {
    if (frozenRestore.current?.noteId !== note.id) {
      frozenRestore.current = {
        noteId: note.id,
        key: crypto.randomUUID(),
        revision: note.revision,
      };
    }
    const attempt = frozenRestore.current;
    setRestoreProblem(null);
    try {
      await changeNoteState(study.id, note.id, 'restore', attempt.revision, attempt.key);
      frozenRestore.current = null;
      void refreshLists();
      void queryClient.invalidateQueries({ queryKey: noteQueryKey(study.id, note.id) });
      void invalidateLibrary(queryClient);
    } catch (error) {
      const definite = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (definite) frozenRestore.current = null;
      setRestoreProblem(definite ? NOTES_COPY.restoreFailed : NOTES_COPY.restoreUnknown);
    }
  }

  function closeNote() {
    const closed = openId;
    returnFocusTo.current = closed;
    setOpenId(null);
    setFreshId(null);
    void refreshLists();
  }

  const notes = live.data?.items ?? [];
  const attached = notes.filter((note) => !note.target?.deleted);
  const orphaned = notes.filter((note) => note.target?.deleted);

  const noteItem = (note: NoteSummary) => (
    <li key={note.id} className="flex flex-col">
      <button
        type="button"
        ref={(element) => {
          if (element) itemButtons.current.set(note.id, element);
          else itemButtons.current.delete(note.id);
        }}
        aria-pressed={openId === note.id}
        onClick={() => setOpenId(note.id)}
        className="text-left underline aria-pressed:font-semibold"
      >
        {note.preview || 'Empty note'}
      </button>
      <span className="text-sm text-muted">
        {targetText(note)} · Updated {formatNoteTime(note.updatedAt)}
      </span>
    </li>
  );

  return (
    <section aria-labelledby={`${ids.target}-heading`} className="flex flex-col gap-4">
      <h2 id={`${ids.target}-heading`} className="font-serif text-2xl">
        Notes
      </h2>
      {!editable ? <p className="text-muted">{NOTES_COPY.readOnly}</p> : null}

      {editable ? (
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={ids.target} className="flex flex-col text-sm">
            Attach to
            <select
              id={ids.target}
              value={target}
              onChange={(event) => setTarget(event.target.value as Target)}
              className="rounded border border-muted bg-canvas px-2 py-1"
            >
              <option value="study">This study</option>
              {study.mainQuestion ? <option value="main">Main question</option> : null}
            </select>
          </label>
          <button
            type="button"
            aria-disabled={creating}
            onClick={() => void create()}
            className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'New note'}
          </button>
        </div>
      ) : null}
      {createProblem ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{createProblem.text}</p>
          {createProblem.retry ? (
            <button type="button" onClick={() => void create(true)} className="underline">
              Retry
            </button>
          ) : (
            <button type="button" onClick={() => void onReload()} className="underline">
              Reload
            </button>
          )}
        </div>
      ) : null}

      {live.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{NOTES_COPY.loadFailed}</p>
          {classifyError(live.error).kind !== 'not_found' ? (
            <button type="button" onClick={() => void live.refetch()} className="underline">
              Retry
            </button>
          ) : null}
        </div>
      ) : !live.data ? (
        <p role="status" className="text-muted">
          Loading notes…
        </p>
      ) : (
        <>
          {attached.length === 0 && orphaned.length === 0 ? (
            <p>{NOTES_COPY.empty}</p>
          ) : (
            <ul aria-label="Notes" className="flex flex-col gap-2">
              {attached.map(noteItem)}
            </ul>
          )}
          {orphaned.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-serif text-xl">Orphaned notes</h3>
              <p className="text-sm text-muted">{NOTES_COPY.orphanedHelp}</p>
              <ul aria-label="Orphaned notes" className="flex flex-col gap-2">
                {orphaned.map(noteItem)}
              </ul>
            </div>
          ) : null}
        </>
      )}

      {openId !== null ? (
        open.data ? (
          editable && open.data.deletedAt === null ? (
            <NoteEditor
              key={open.data.id}
              studyId={study.id}
              note={open.data}
              autoFocus={freshId === open.data.id}
              onClose={closeNote}
              onUnsavedChange={onUnsavedChange}
              onReloadStudy={() => void onReload()}
            />
          ) : (
            <div className="flex flex-col gap-2 rounded border border-muted p-3">
              <NoteContent doc={open.data.content} label="Note" />
              <button type="button" onClick={closeNote} className="self-start underline">
                Close note
              </button>
            </div>
          )
        ) : open.isError ? (
          <p role="alert">Couldn&apos;t open this note.</p>
        ) : (
          <p role="status">Opening the note…</p>
        )
      ) : null}

      <div className="flex flex-col gap-2">
        <button
          ref={trashToggle}
          type="button"
          aria-expanded={showTrash}
          aria-controls={ids.trash}
          onClick={() => setShowTrash((value) => !value)}
          className="self-start text-accent underline"
        >
          Note trash
        </button>
        {showTrash ? (
          <div id={ids.trash} className="flex flex-col gap-2">
            {trashed.isError ? (
              <p role="alert">{NOTES_COPY.loadFailed}</p>
            ) : !trashed.data ? (
              <p role="status">Loading the note trash…</p>
            ) : trashed.data.items.length === 0 ? (
              <p>{NOTES_COPY.trashEmpty}</p>
            ) : (
              <ul aria-label="Note trash" className="flex flex-col gap-2">
                {trashed.data.items.map((note) => (
                  <li key={note.id} className="flex flex-wrap items-center gap-3">
                    <span>{note.preview || 'Empty note'}</span>
                    <span className="text-sm text-muted">
                      Moved to trash {note.deletedAt ? formatNoteTime(note.deletedAt) : ''}
                    </span>
                    {editable ? (
                      <button
                        type="button"
                        onClick={() => void restore(note)}
                        aria-label={`Restore note: ${note.preview || 'Empty note'}`}
                        className="underline"
                      >
                        Restore
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {restoreProblem ? <p role="alert">{restoreProblem}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
