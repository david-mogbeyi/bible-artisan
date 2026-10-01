'use client';

import {
  httpUrlSchema,
  MAX_NOTE_CHARACTERS,
  NOTE_TRASHED,
  type NoteDocument,
  type NoteMutationResponse,
  type NoteResponse,
  STUDY_ARCHIVED,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import {
  changeNoteState,
  fetchNote,
  noteListsKey,
  noteQueryKey,
  noteVersionsQueryKey,
  saveNote,
} from '@/lib/notes';
import { invalidateLibrary } from '@/lib/studies';
import { NOTE_LINK_REL, NOTE_LINK_TARGET } from './note-content';
import { characterCount, NoteAutosave, type SaveState } from './note-autosave';
import { toNoteDocument } from './note-document';
import { NoteVersions } from './note-versions';

const LIMIT = MAX_NOTE_CHARACTERS.toLocaleString('en-US');
/** The counter warns from here on. */
const WARN_AT = 45_000;

export const SAVE_COPY = {
  saved: 'Saved',
  pending: 'Changes not saved yet',
  saving: 'Saving…',
  failed: "Couldn't save. Your text is still here, and Retry won't save it twice.",
  conflict:
    'This note changed somewhere else, so this edit was not saved. Your text is still here.',
  tooLong: `Too long to save: a note can have at most ${LIMIT} characters. Your text is still here.`,
  invalid: "This formatting can't be saved. Your text is still here.",
  archived: 'This study was archived, so this edit was not saved. Reload to see it.',
  studyTrashed: 'This study was moved to the trash, so this edit was not saved. Reload to see it.',
  noteTrashed: 'This note was moved to the trash, so this edit was not saved. Reload to see it.',
  gone: "This note isn't available any more.",
  alreadyVersioned: 'This version is already saved.',
} as const;

function stateText(state: SaveState): string {
  switch (state.kind) {
    case 'saved':
      return SAVE_COPY.saved;
    case 'pending':
      return SAVE_COPY.pending;
    case 'saving':
      return SAVE_COPY.saving;
    case 'failed':
      return SAVE_COPY.failed;
    case 'conflict':
      return SAVE_COPY.conflict;
    case 'too_long':
      return SAVE_COPY.tooLong;
    case 'invalid':
      return SAVE_COPY.invalid;
    case 'locked':
      return state.code === STUDY_ARCHIVED
        ? SAVE_COPY.archived
        : state.code === NOTE_TRASHED
          ? SAVE_COPY.noteTrashed
          : SAVE_COPY.studyTrashed;
    case 'gone':
      return SAVE_COPY.gone;
    case 'already_versioned':
      return SAVE_COPY.alreadyVersioned;
  }
}

const LINK_INVALID = 'Enter a full web address starting with http:// or https://.';

/**
 * Edits one note (BIB-23; PRD sections 15, 27). The Tiptap editor is restricted to the note
 * allowlist (no code, strike, underline, rule, image or HTML), links accept http(s) only and
 * render with safe `rel`/`target`, and its JSON is normalized and validated before it is sent.
 *
 * Saving follows `NoteAutosave`: 750 ms after typing stops (five seconds at most), one request at
 * a time, frozen for a byte-identical retry, "Saved" only after the server acknowledged the
 * latest content. Over the limit nothing is sent and the draft stays. A conflict stops autosave
 * and keeps the draft; the user chooses Keep mine (saved as a new version) or Reload latest. The
 * page warns before unload while anything is unsaved; closing the editor saves first.
 */
export function NoteEditor({
  studyId,
  note,
  autoFocus = false,
  onClose,
  onUnsavedChange,
  onReloadStudy,
}: {
  studyId: string;
  note: NoteResponse;
  /** Focus the text at once (a note just created). */
  autoFocus?: boolean;
  onClose: () => void;
  /** Whether the editor holds unacknowledged work (the page blocks archive/trash meanwhile). */
  onUnsavedChange: (unsaved: boolean) => void;
  /** Refetches the study (after an archive or trash elsewhere). */
  onReloadStudy: () => void;
}) {
  const queryClient = useQueryClient();
  const ids = { counter: useId(), status: useId(), link: useId(), linkError: useId() };
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const [count, setCount] = useState(() => characterCount(note.content));
  const [closing, setClosing] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [trashProblem, setTrashProblem] = useState<string | null>(null);
  const [trashing, setTrashing] = useState(false);
  const trashAttempt = useRef<{ key: string; revision: number } | null>(null);
  const [reloadProblem, setReloadProblem] = useState(false);

  // One autosave per open note, created once (the editor is keyed by note id).
  const [saver] = useState(
    () =>
      new NoteAutosave({
        revision: note.revision,
        content: note.content,
        send: (body, key) => saveNote(studyId, note.id, body, key),
        onState: setState,
        onSaved: (saved: NoteMutationResponse) => {
          // Previews, the version list and library search reflect the saved text.
          void queryClient.invalidateQueries({ queryKey: noteListsKey(studyId) });
          void queryClient.invalidateQueries({ queryKey: noteVersionsQueryKey(studyId, note.id) });
          queryClient.setQueryData<NoteResponse>(noteQueryKey(studyId, note.id), (old) =>
            old && saved.revision >= old.revision
              ? { ...old, revision: saved.revision, latestVersionNumber: saved.latestVersionNumber }
              : old,
          );
          void invalidateLibrary(queryClient);
        },
      }),
  );

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        strike: false,
        underline: false,
        horizontalRule: false,
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          isAllowedUri: (url) => httpUrlSchema.safeParse(url).success,
          HTMLAttributes: { rel: NOTE_LINK_REL, target: NOTE_LINK_TARGET },
        },
      }),
    ],
    content: note.content,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Note text',
        'aria-describedby': `${ids.counter} ${ids.status}`,
        class:
          'min-h-40 rounded border border-muted bg-canvas p-3 focus:outline-2 focus:outline-accent [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_a]:underline',
      },
    },
    onUpdate: ({ editor: changed }) => {
      const doc = toNoteDocument(changed.getJSON());
      if (doc) setCount(characterCount(doc));
      saver.edited(doc);
    },
  });

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      h1: current?.isActive('heading', { level: 1 }) ?? false,
      h2: current?.isActive('heading', { level: 2 }) ?? false,
      h3: current?.isActive('heading', { level: 3 }) ?? false,
      bullet: current?.isActive('bulletList') ?? false,
      ordered: current?.isActive('orderedList') ?? false,
      quote: current?.isActive('blockquote') ?? false,
      link: current?.isActive('link') ?? false,
      canUndo: current?.can().undo() ?? false,
      canRedo: current?.can().redo() ?? false,
    }),
  });

  const unsaved = saver.unsaved || state.kind === 'saving' || state.kind === 'pending';
  useEffect(() => {
    onUnsavedChange(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange]);

  // Unacknowledged work: the browser asks before the page goes (PRD section 27).
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // Leaving the note (route change, closing) sends what is unsaved first.
  useEffect(() => () => saver.dispose(), [saver]);

  // Close waits until the latest content is saved.
  useEffect(() => {
    if (closing && state.kind === 'saved') onClose();
  }, [closing, state, onClose]);

  const stopped = state.kind === 'conflict' || state.kind === 'locked' || state.kind === 'gone';
  // Read-only once the study or note is locked or gone (the draft stays visible). No update
  // event: making the editor read-only is not an edit, and must not reach autosave.
  const writable = !stopped || state.kind === 'conflict';
  useEffect(() => {
    if (editor && editor.isEditable !== writable) editor.setEditable(writable, false);
  }, [editor, writable]);

  function close() {
    if (!saver.unsaved) return onClose();
    setClosing(true);
    saver.flush();
  }

  async function reloadLatest() {
    setReloadProblem(false);
    try {
      const fresh = await fetchNote(studyId, note.id);
      queryClient.setQueryData(noteQueryKey(studyId, note.id), fresh);
      editor?.commands.setContent(fresh.content, { emitUpdate: false });
      setCount(characterCount(fresh.content));
      saver.reset(fresh.revision, fresh.content);
    } catch {
      setReloadProblem(true);
    }
  }

  async function keepMine() {
    setReloadProblem(false);
    try {
      const fresh = await fetchNote(studyId, note.id);
      saver.keepMine(fresh.revision);
    } catch {
      setReloadProblem(true);
    }
  }

  function restoreVersion(content: NoteDocument) {
    editor?.commands.setContent(content, { emitUpdate: false });
    setCount(characterCount(content));
    saver.restore(content);
  }

  function applyLink(event: FormEvent) {
    event.preventDefault();
    const parsed = httpUrlSchema.safeParse(linkValue);
    if (!parsed.success) {
      setLinkError(LINK_INVALID);
      return;
    }
    const href = parsed.data;
    const chain = editor?.chain().focus();
    if (editor?.state.selection.empty && !editor.isActive('link')) {
      chain
        ?.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else {
      chain?.extendMarkRange('link').setLink({ href }).run();
    }
    setLinkOpen(false);
    setLinkValue('');
    setLinkError(null);
  }

  function removeLink() {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
  }

  async function trash() {
    if (trashing || unsaved) return;
    setTrashing(true);
    setTrashProblem(null);
    trashAttempt.current ??= { key: crypto.randomUUID(), revision: saver.currentRevision };
    const attempt = trashAttempt.current;
    try {
      await changeNoteState(studyId, note.id, 'trash', attempt.revision, attempt.key);
      trashAttempt.current = null;
      void queryClient.invalidateQueries({ queryKey: noteListsKey(studyId) });
      void queryClient.invalidateQueries({ queryKey: noteQueryKey(studyId, note.id) });
      void invalidateLibrary(queryClient);
      onClose();
    } catch (error) {
      const definite = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (definite) trashAttempt.current = null;
      setTrashProblem(
        definite
          ? "Couldn't move this note to the trash. Reload the study and try again."
          : "Couldn't confirm the note moved to the trash. Retry won't do it twice.",
      );
    } finally {
      setTrashing(false);
    }
  }

  const tool = (
    label: string,
    pressed: boolean | undefined,
    run: () => void,
    shortcut?: string,
  ) => (
    <button
      type="button"
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      onClick={run}
      className="rounded border border-muted px-2 py-1 text-sm aria-pressed:bg-accent aria-pressed:text-canvas"
    >
      {label}
    </button>
  );

  const canSaveVersion = !stopped && state.kind !== 'too_long' && state.kind !== 'invalid';
  const overLimit = count > MAX_NOTE_CHARACTERS;

  return (
    <section aria-label="Note editor" className="flex flex-col gap-3">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-2">
        {tool('Bold', active?.bold, () => editor?.chain().focus().toggleBold().run(), 'Control+B')}
        {tool(
          'Italic',
          active?.italic,
          () => editor?.chain().focus().toggleItalic().run(),
          'Control+I',
        )}
        {tool('Heading 1', active?.h1, () =>
          editor?.chain().focus().toggleHeading({ level: 1 }).run(),
        )}
        {tool('Heading 2', active?.h2, () =>
          editor?.chain().focus().toggleHeading({ level: 2 }).run(),
        )}
        {tool('Heading 3', active?.h3, () =>
          editor?.chain().focus().toggleHeading({ level: 3 }).run(),
        )}
        {tool('Bullet list', active?.bullet, () =>
          editor?.chain().focus().toggleBulletList().run(),
        )}
        {tool('Numbered list', active?.ordered, () =>
          editor?.chain().focus().toggleOrderedList().run(),
        )}
        {tool('Quote', active?.quote, () => editor?.chain().focus().toggleBlockquote().run())}
        <button
          type="button"
          aria-pressed={active?.link}
          aria-expanded={linkOpen}
          aria-controls={ids.link}
          onClick={() => {
            setLinkValue((editor?.getAttributes('link').href as string | undefined) ?? '');
            setLinkError(null);
            setLinkOpen((open) => !open);
          }}
          className="rounded border border-muted px-2 py-1 text-sm aria-pressed:bg-accent aria-pressed:text-canvas"
        >
          Link
        </button>
        <button
          type="button"
          aria-disabled={!active?.canUndo}
          aria-keyshortcuts="Control+Z"
          onClick={() => active?.canUndo && editor?.chain().focus().undo().run()}
          className="rounded border border-muted px-2 py-1 text-sm aria-disabled:opacity-60"
        >
          Undo
        </button>
        <button
          type="button"
          aria-disabled={!active?.canRedo}
          aria-keyshortcuts="Control+Shift+Z"
          onClick={() => active?.canRedo && editor?.chain().focus().redo().run()}
          className="rounded border border-muted px-2 py-1 text-sm aria-disabled:opacity-60"
        >
          Redo
        </button>
      </div>
      {linkOpen ? (
        <form id={ids.link} onSubmit={applyLink} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm">
            Link address
            <input
              type="url"
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              aria-invalid={linkError !== null}
              aria-describedby={linkError ? ids.linkError : undefined}
              className="rounded border border-muted px-2 py-1"
              autoFocus
            />
          </label>
          <button type="submit" className="rounded border border-muted px-2 py-1 text-sm">
            Apply link
          </button>
          {active?.link ? (
            <button
              type="button"
              onClick={removeLink}
              className="rounded border border-muted px-2 py-1 text-sm"
            >
              Remove link
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setLinkOpen(false);
              editor?.commands.focus();
            }}
            className="rounded border border-muted px-2 py-1 text-sm"
          >
            Cancel
          </button>
          {linkError ? (
            <p id={ids.linkError} role="alert" className="w-full text-sm font-medium text-accent">
              {linkError}
            </p>
          ) : null}
        </form>
      ) : null}

      <EditorContent editor={editor} />

      <p
        id={ids.counter}
        className={
          overLimit || count > WARN_AT ? 'text-sm font-medium text-accent' : 'text-sm text-muted'
        }
      >
        {count.toLocaleString('en-US')} / {LIMIT} characters
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <p id={ids.status} role="status" aria-live="polite" className="text-sm">
          {stateText(state)}
        </p>
        {state.kind === 'failed' ? (
          <button type="button" onClick={() => saver.flush()} className="text-accent underline">
            Retry
          </button>
        ) : null}
        {state.kind === 'conflict' ? (
          <>
            <button type="button" onClick={() => void keepMine()} className="text-accent underline">
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => void reloadLatest()}
              className="text-accent underline"
            >
              Discard mine and reload latest
            </button>
          </>
        ) : null}
        {state.kind === 'locked' ? (
          <button type="button" onClick={onReloadStudy} className="text-accent underline">
            Reload
          </button>
        ) : null}
      </div>
      {reloadProblem ? (
        <p role="alert" className="text-sm font-medium text-accent">
          Couldn&apos;t load the latest note. Your text is still here.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          aria-disabled={!canSaveVersion}
          onClick={() => canSaveVersion && saver.checkpoint()}
          className="rounded border border-muted px-3 py-1 aria-disabled:opacity-60"
        >
          Save version
        </button>
        <button
          type="button"
          aria-disabled={unsaved || trashing}
          aria-describedby={unsaved ? ids.status : undefined}
          onClick={() => void trash()}
          className="rounded border border-muted px-3 py-1 aria-disabled:opacity-60"
        >
          Move to trash
        </button>
        <button
          type="button"
          aria-disabled={closing}
          onClick={() => !closing && close()}
          className="rounded border border-muted px-3 py-1"
        >
          {closing ? 'Saving, then closing…' : 'Close note'}
        </button>
      </div>
      {trashProblem ? (
        <p role="alert" className="text-sm font-medium text-accent">
          {trashProblem}
        </p>
      ) : null}

      <NoteVersions
        studyId={studyId}
        noteId={note.id}
        canRestore={!stopped}
        onRestore={restoreVersion}
      />
    </section>
  );
}
