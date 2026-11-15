'use client';

import {
  httpUrlSchema,
  MAX_NOTE_CHARACTERS,
  MAX_SEARCH_QUERY_LENGTH,
  type ReferenceCandidate,
  NOTE_TRASHED,
  type NoteDocument,
  type NoteMutationResponse,
  type NoteConflictResolution,
  noteNodeMentions,
  notePlainText,
  type MeResponse,
  type NoteResponse,
  STUDY_ARCHIVED,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, type Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep } from '@tiptap/pm/transform';
import {
  type Editor,
  EditorContent,
  Node as TiptapNode,
  useEditor,
  useEditorState,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError } from '@/lib/api-client';
import { ME_QUERY_KEY } from '@/lib/auth';
import { classifyError, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import {
  bibleHref,
  fetchTranslations,
  resolveReference,
  TRANSLATIONS_QUERY_KEY,
} from '@/lib/bible';
import {
  changeNoteState,
  fetchNote,
  noteListsKey,
  noteQueryKey,
  noteVersionsQueryKey,
  saveNote,
} from '@/lib/notes';
import { useNoteTabs } from '@/lib/note-tabs';
import {
  claimNote,
  downloadDrafts,
  dropQueuedNote,
  getQueuedNote,
  queueNoteSave,
} from '@/lib/offline-queue';
import { invalidateLibrary } from '@/lib/studies';
import { MAKE_NODE_COPY, MakeNodeForm } from './make-node-form';
import { MENTION_COPY, MentionNodeForm } from './mention-node-form';
import { NOTE_LINK_REL, NOTE_LINK_TARGET } from './note-content';
import { characterCount, NoteAutosave, type SaveState } from './note-autosave';
import { cleanNoteText, type NoteContentProblem, toNoteDraft } from './note-document';
import { NoteVersions } from './note-versions';

const LIMIT = MAX_NOTE_CHARACTERS.toLocaleString('en-US');
/** The counter warns from here on. */
const WARN_AT = 45_000;

export const SAVE_COPY = {
  saved: 'Saved',
  pending: 'Changes not saved yet',
  saving: 'Saving…',
  failed: "Couldn't save. Your text is still here, and Retry won't save it twice.",
  waiting:
    "Waiting to sync: you're offline. Your text is still here and saves when you're back online.",
  queueFull:
    "Waiting to sync, and this browser can't keep any more offline edits, so editing is paused until you're back online. Your text is still here; download it to keep a copy.",
  signedOut:
    'Your session expired, so this edit was not saved. Your text is still here. Sign in again in another tab, then come back or choose Retry.',
  conflict:
    'Conflict needs review: this note changed somewhere else, so this edit was not saved. Your text is still here.',
  otherTab:
    'This note is also open in another tab. Edits in both may conflict; nothing is overwritten without asking.',
  tooLong: `Too long to save: a note can have at most ${LIMIT} characters. Your text is still here.`,
  tooLarge:
    'This note is too large to save. Try removing long links or splitting it into two notes. Your text is still here.',
  invalid: "This formatting can't be saved. Your text is still here.",
  archived: 'This study was archived, so this edit was not saved. Reload to see it.',
  studyTrashed: 'This study was moved to the trash, so this edit was not saved. Reload to see it.',
  noteTrashed: 'This note was moved to the trash, so this edit was not saved. Reload to see it.',
  gone: "This note isn't available any more.",
  alreadyVersioned: 'This version is already saved.',
  closeBlocked: "This note has changes that aren't saved, so it stays open.",
  closeFailed: "Couldn't save this note, so it stays open. Your text is still here.",
} as const;

/** What can't be saved, by kind of content (the generic copy is `SAVE_COPY.invalid`). */
export const INVALID_COPY: Record<NoteContentProblem, string> = {
  link: "A link isn't a full web address (starting with http:// or https://), so this can't be saved. Edit or remove the link. Your text is still here.",
  list_numbering:
    "A numbered list's numbering can't be saved: it must start between 1 and 10,000. Your text is still here.",
  characters:
    "Some characters (such as invisible control characters) can't be saved. Your text is still here.",
  too_deep:
    'Lists and quotes are nested too deeply to save (at most 12 levels). Your text is still here.',
  too_many_parts:
    'This note has too many paragraphs, list items or line breaks to save. Try splitting it into two notes. Your text is still here.',
  reference:
    "A Bible reference link in this note couldn't be verified, so this can't be saved. Remove it, or resolve the reference again. Your text is still here.",
  mention:
    "A node mentioned in this note isn't part of this study any more, so this can't be saved. Remove the mention, or mention the node again. Your text is still here.",
  structure: SAVE_COPY.invalid,
};

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
    case 'waiting':
      return SAVE_COPY.waiting;
    case 'queue_full':
      return SAVE_COPY.queueFull;
    case 'signed_out':
      return SAVE_COPY.signedOut;
    case 'conflict':
      return SAVE_COPY.conflict;
    case 'too_long':
      return SAVE_COPY.tooLong;
    case 'too_large':
      return SAVE_COPY.tooLarge;
    case 'invalid':
      return INVALID_COPY[state.problem];
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

/** "Resolve reference" outcomes, in fixed copy (never the typed text). */
const RESOLVE_COPY = {
  empty: 'Select a Bible reference in the note, such as Romans 9:1, then choose Resolve reference.',
  tooLong: 'Select just the reference, such as Romans 9:1.',
  notReference: 'The selected text is not a Bible reference, so nothing was linked.',
  changed: 'The selected text changed, so nothing was linked. Select the reference again.',
  failed: "Couldn't check the reference. Try again.",
  ambiguous: 'That book name matches more than one book. Choose one:',
} as const;

/**
 * A reference link carries no marks (the allowlist refuses them). ProseMirror decides which
 * marks an inline node may take from its parent, not from the node's own spec, so bold, italic or
 * a web link applied over a selection containing one would mark it too and make the note
 * unsavable. After any mark step, this takes them off again; `toNoteDraft` also drops any that
 * arrive another way.
 */
const ATOM_LINKS = new Set(['scriptureReference', 'nodeMention']);

const referenceWithoutMarks = new Plugin({
  key: new PluginKey('scriptureReferenceWithoutMarks'),
  appendTransaction(transactions, _old, state) {
    const marked = transactions.some((tr) => tr.steps.some((step) => step instanceof AddMarkStep));
    if (!marked) return null;
    let tr: Transaction | null = null;
    state.doc.descendants((node, pos) => {
      if (ATOM_LINKS.has(node.type.name) && node.marks.length > 0) {
        tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, node.attrs, []);
      }
    });
    return tr;
  },
});

/**
 * A verified Bible reference link (BIB-24, FR-NOTE-003): an inline atom holding a shared
 * reference id and its canonical label, inserted only by "Resolve reference" after the server
 * resolved the selected text. It is deleted as a unit and shows its label as text. The server
 * verifies both attributes on every save (422 `NOTE_REFERENCE_INVALID`), so a pasted or edited
 * one can never point at a passage other than the one it names.
 */
const ScriptureReferenceNode = TiptapNode.create({
  name: 'scriptureReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { referenceId: { default: null }, label: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-scripture-reference]',
        getAttrs: (element) => ({
          referenceId: element.getAttribute('data-scripture-reference'),
          label: element.textContent ?? '',
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const referenceId = String(node.attrs.referenceId ?? '');
    return [
      'a',
      { 'data-scripture-reference': referenceId, href: bibleHref(referenceId) },
      String(node.attrs.label ?? ''),
    ];
  },
  renderText({ node }) {
    return String(node.attrs.label ?? '');
  },
  addProseMirrorPlugins() {
    return [referenceWithoutMarks];
  },
});

/**
 * A mention of a node of this study (BIB-58): an inline atom holding the node's id and its label
 * when mentioned, inserted only from "Mention node…" (a live node from the node list). The server
 * checks a new mention against the node on save (422 `NOTE_MENTION_INVALID`). Its link is
 * relative (`?node=`), so it opens the node on the study page it is shown on. Marks are stripped
 * like a reference link's.
 */
const NodeMentionNode = TiptapNode.create({
  name: 'nodeMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { nodeId: { default: null }, label: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-node-mention]',
        getAttrs: (element) => ({
          nodeId: element.getAttribute('data-node-mention'),
          label: element.textContent ?? '',
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const nodeId = String(node.attrs.nodeId ?? '');
    return [
      'a',
      { 'data-node-mention': nodeId, href: `?node=${encodeURIComponent(nodeId)}` },
      String(node.attrs.label ?? ''),
    ];
  },
  renderText({ node }) {
    return String(node.attrs.label ?? '');
  },
});

/** The text an inline atom stands for in plain text: a link's label, else a line break. */
function leafText(leaf: ProseMirrorNode): string {
  return ATOM_LINKS.has(leaf.type.name) ? String(leaf.attrs.label ?? '') : '\n';
}

/**
 * The selection without the whitespace (or block boundaries) at either end, so "Resolve
 * reference" replaces exactly the reference and keeps the spaces around it.
 */
export function trimmedRange(
  doc: ProseMirrorNode,
  { from, to }: { from: number; to: number },
): { from: number; to: number } {
  const blank = (a: number, b: number) => doc.textBetween(a, b, ' ', ' ').trim() === '';
  let start = from;
  let end = to;
  while (start < end && blank(start, start + 1)) start += 1;
  while (end > start && blank(end - 1, end)) end -= 1;
  return { from: start, to: end };
}

/**
 * The editor's schema: the note allowlist and nothing else (no code, strike, underline, rule,
 * image or HTML). Built once for every editor, so a render never reconfigures Tiptap. Pasted HTML
 * goes through this schema too, so an image, script, table or unknown mark in it is dropped.
 */
const NOTE_EXTENSIONS = [
  ScriptureReferenceNode,
  NodeMentionNode,
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
];

const EDITOR_CLASS =
  'min-h-40 rounded border border-muted bg-canvas p-3 focus:outline-2 focus:outline-accent [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_a]:underline';

/** Pasted content with every text run cleaned (`cleanNoteText`); empty runs dropped. */
function cleanFragment(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const text = cleanNoteText(node.text ?? '');
      if (text !== '') nodes.push(node.type.schema.text(text, node.marks));
    } else {
      nodes.push(node.copy(cleanFragment(node.content)));
    }
  });
  return Fragment.fromArray(nodes);
}

/** Counts per document: ProseMirror documents are immutable, so a count never goes stale. */
const counted = new WeakMap<ProseMirrorNode, number>();

/**
 * The note's plain-text length as the server counts it (`notePlainText`: a line break between
 * text blocks and for each hard break), read straight from the editor's document without
 * serializing it; once per document, however often it is asked for.
 */
function editorCharacters(editor: Editor): number {
  const { doc } = editor.state;
  const known = counted.get(doc);
  if (known !== undefined) return known;
  let count = 0;
  for (const _ of doc.textBetween(0, doc.content.size, '\n', leafText)) count += 1;
  counted.set(doc, count);
  return count;
}

/** Closing (or switching away from) the open note. */
export interface NoteEditorHandle {
  /**
   * Saves what is unsaved and resolves true once the server acknowledged it (the note may then
   * close). Resolves false, keeping the note open with an explanation, when the draft can't be
   * saved (too long, invalid, refused) or the save failed.
   */
  close(): Promise<boolean>;
}

/**
 * Edits one note (BIB-23; PRD sections 15, 27). The Tiptap editor is restricted to the note
 * allowlist (no code, strike, underline, rule, image or HTML), links accept http(s) only and
 * render with safe `rel`/`target`, and its JSON is normalized and validated before it is sent.
 *
 * Saving follows `NoteAutosave`: 750 ms after typing stops (five seconds at most), one request at
 * a time, frozen for a byte-identical retry, "Saved" only after the server acknowledged the
 * latest content. Over the limit nothing is sent and the draft stays. A conflict stops autosave
 * and keeps the draft beside the server text; the user chooses Keep server version, Save my
 * version or Combine manually (BIB-37). Offline it waits to sync; an expired session pauses
 * with the draft kept. The page warns before unload while anything is unsaved; closing the
 * editor saves first.
 */
export function NoteEditor({
  studyId,
  studyRevision,
  note,
  editionId = null,
  autoFocus = false,
  handle,
  onClose,
  onUnsavedChange,
  onReloadStudy,
}: {
  studyId: string;
  /** The study's revision, for "Make node…" (BIB-57): creating a node is a study change. */
  studyRevision: number;
  note: NoteResponse;
  /**
   * The translation typed references resolve in (BIB-24): the study's starting passage edition;
   * null falls back to the first active translation.
   */
  editionId?: string | null;
  /** Focus the text at once (a note just created). */
  autoFocus?: boolean;
  /** Lets the panel close this note through the same save-first path before switching notes. */
  handle?: RefObject<NoteEditorHandle | null>;
  onClose: () => void;
  /** Whether the editor holds unacknowledged work (the page blocks archive/trash meanwhile). */
  onUnsavedChange: (unsaved: boolean) => void;
  /** Refetches the study (after an archive or trash elsewhere). */
  onReloadStudy: () => void;
}) {
  const queryClient = useQueryClient();
  const ids = { counter: useId(), status: useId(), link: useId(), linkError: useId() };
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const [closing, setClosing] = useState(false);
  const [closeProblem, setCloseProblem] = useState<string | null>(null);
  const closeAttempt = useRef<Promise<boolean> | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [trashProblem, setTrashProblem] = useState<string | null>(null);
  const [trashing, setTrashing] = useState(false);
  const trashAttempt = useRef<{ key: string; revision: number } | null>(null);
  const [reloadProblem, setReloadProblem] = useState(false);
  // "Make node…" (BIB-57): the selected text it opened with, and the outcome it announced.
  const [makeNode, setMakeNode] = useState<{ text: string } | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const makeNodeButton = useRef<HTMLButtonElement>(null);
  // "Mention node…" (BIB-58): whether its picker is open, and where focus returns.
  const [mentionOpen, setMentionOpen] = useState(false);
  const mentionButton = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  // "Resolve reference" (BIB-24): the selection it was asked for, and what came back.
  const [resolving, setResolving] = useState(false);
  const [resolveMessage, setResolveMessage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{
    from: number;
    to: number;
    text: string;
    options: ReferenceCandidate[];
  } | null>(null);

  const tabs = useNoteTabs(studyId, note.id);
  const announceSaved = useRef(tabs.announceSaved);
  useEffect(() => {
    announceSaved.current = tabs.announceSaved;
  }, [tabs.announceSaved]);
  // After a 409: the note as the server holds it now, shown beside this tab's text (BIB-37).
  const [server, setServer] = useState<NoteResponse | null>(null);
  const [mineAtConflict, setMineAtConflict] = useState('');
  const [combining, setCombining] = useState(false);
  // Set below, once the editor exists: what entering a conflict does.
  const onConflict = useRef<() => void>(() => undefined);

  // One autosave per open note, created once (the editor is keyed by note id).
  const [saver] = useState(
    () =>
      new NoteAutosave({
        revision: note.revision,
        content: note.content,
        send: (body, key) => saveNote(studyId, note.id, body, key),
        onState: (next: SaveState) => {
          setState(next);
          if (next.kind === 'conflict') onConflict.current();
        },
        onSaved: (saved: NoteMutationResponse, content: NoteDocument) => {
          // Previews, the version list and library search reflect the saved text.
          void queryClient.invalidateQueries({ queryKey: noteListsKey(studyId) });
          void queryClient.invalidateQueries({ queryKey: noteVersionsQueryKey(studyId, note.id) });
          // The cached note becomes exactly what the server acknowledged: the content sent with
          // the revision it produced, never one version's content with another's revision.
          queryClient.setQueryData<NoteResponse>(noteQueryKey(studyId, note.id), (old) =>
            old && saved.revision >= old.revision
              ? {
                  ...old,
                  content,
                  revision: saved.revision,
                  latestVersionNumber: saved.latestVersionNumber,
                  characterCount: saved.characterCount,
                  updatedAt: saved.updatedAt,
                }
              : old,
          );
          void invalidateLibrary(queryClient);
          // Other tabs with this note open refetch it (ids and revision only).
          announceSaved.current(saved.revision);
        },
        // Offline, unacknowledged work goes to the bounded offline queue (BIB-36), under the
        // signed-in account; without an account (never here) it stays in memory.
        persist: async (snapshot) => {
          if (snapshot === null) {
            await dropQueuedNote(note.id);
            return 'queued';
          }
          const accountId = queryClient.getQueryData<MeResponse>(ME_QUERY_KEY)?.id;
          if (!accountId) return 'unavailable';
          return queueNoteSave({ accountId, studyId, noteId: note.id, ...snapshot });
        },
      }),
  );
  // This tab's editor owns the note's offline entry while open: background replay skips it.
  useEffect(() => claimNote(note.id), [note.id]);

  // Options built once: a render never reconfigures the editor.
  const [initialContent] = useState(note.content);
  const editorProps = useMemo(
    () => ({
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Note text',
        'aria-describedby': `${ids.counter} ${ids.status}`,
        class: EDITOR_CLASS,
      },
      // Pasted text and HTML: control characters become spaces before they reach the document.
      transformPasted: (slice: Slice) =>
        new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd),
    }),
    [ids.counter, ids.status],
  );

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    extensions: NOTE_EXTENSIONS,
    content: initialContent,
    editorProps,
    onUpdate: ({ editor: changed }) => {
      // A keystroke: count characters and mark the draft dirty; nothing is serialized here.
      saver.touched(editorCharacters(changed));
    },
  });
  // The document is serialized and checked only when a save is due, never per keystroke.
  useEffect(() => {
    if (editor) saver.attachReader(() => toNoteDraft(editor.getJSON()));
  }, [editor, saver]);

  // Work this note still has in the offline queue (an editor closed while offline) is where
  // editing continues: shown, and sent first, never overwritten by this editor's own entry.
  // An entry kept only for download (its replay was refused) is left to the download notice.
  useEffect(() => {
    if (!editor) return;
    let live = true;
    void getQueuedNote(note.id).then((entry) => {
      const accountId = queryClient.getQueryData<MeResponse>(ME_QUERY_KEY)?.id;
      if (!live || !entry || entry.failed || entry.accountId !== accountId) return;
      const content = saver.adopt(entry);
      if (!content) return;
      editor.commands.setContent(content, { emitUpdate: false });
      saver.flush();
    });
    return () => {
      live = false;
    };
  }, [editor, saver, note.id, queryClient]);

  // The note as loaded changed (a refetch, another tab's save) while nothing here is unsaved:
  // show it, and save from its revision. Older copies are ignored.
  useEffect(() => {
    if (!editor || saver.unsaved) return;
    const newer = note.revision > saver.currentRevision;
    const differs = note.revision === saver.currentRevision && !saver.holds(note.content);
    if (!newer && !differs) return;
    editor.commands.setContent(note.content, { emitUpdate: false });
    saver.reset(note.revision, note.content);
  }, [editor, note.revision, note.content, saver]);

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
      hasSelection: current ? !current.state.selection.empty : false,
      count: current ? editorCharacters(current) : null,
    }),
  });
  const count = active?.count ?? characterCount(initialContent);

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
  useEffect(() => {
    saver.mounted();
    return () => saver.dispose();
  }, [saver]);

  // Back online, or back in this tab (perhaps after signing in again elsewhere): resend what
  // waits. Server acknowledgement alone still decides Saved.
  useEffect(() => {
    const resume = () => saver.reconnected();
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
    };
  }, [saver]);

  const stopped = state.kind === 'conflict' || state.kind === 'locked' || state.kind === 'gone';
  // Read-only once the study or note is locked or gone (the draft stays visible). No update
  // event: making the editor read-only is not an edit, and must not reach autosave.
  // A full offline queue pauses editing too (FR-SAVE-004), with the draft offered as a download.
  const writable = (!stopped || state.kind === 'conflict') && state.kind !== 'queue_full';
  useEffect(() => {
    if (editor && editor.isEditable !== writable) editor.setEditable(writable, false);
  }, [editor, writable]);

  /**
   * Saves first, then resolves true; never drops unsaved work. Work that can't be saved (too
   * long, refused content, a conflict, a locked study) or a save that fails resolves false, and
   * the note stays open saying why.
   */
  function close(): Promise<boolean> {
    if (closeAttempt.current) return closeAttempt.current;
    setCloseProblem(null);
    if (!saver.unsaved) return Promise.resolve(true);
    setClosing(true);
    const attempt = saver.saveForClose().then((ok) => {
      closeAttempt.current = null;
      setClosing(false);
      if (!ok) {
        setCloseProblem(
          saver.current.kind === 'failed' ? SAVE_COPY.closeFailed : SAVE_COPY.closeBlocked,
        );
      }
      return ok;
    });
    closeAttempt.current = attempt;
    return attempt;
  }

  useImperativeHandle(handle, () => ({ close }));

  /** Saves the editor's text as a file (a full offline queue can't keep it; FR-SAVE-004). */
  function downloadDraft() {
    if (!editor) return;
    const draft = toNoteDraft(editor.getJSON());
    downloadDrafts([
      {
        studyId,
        noteId: note.id,
        text: editor.getText({ blockSeparator: '\n' }),
        content: draft.ok ? draft.doc : editor.getJSON(),
      },
    ]);
  }

  /** Explicitly leaves without saving (offered only once a close was refused). */
  function discardAndClose() {
    saver.discard();
    onClose();
  }

  // A conflict: snapshot this tab's text and read the server's current note to show beside it.
  // Nothing is overwritten until the user chooses (BIB-37).
  useEffect(() => {
    onConflict.current = () => {
      setServer(null);
      setCombining(false);
      setMineAtConflict(editor ? editor.getText({ blockSeparator: '\n' }) : '');
      void loadServer().then((fresh) => {
        if (fresh && saver.current.kind === 'conflict') setServer(fresh);
      });
    };
  });

  /** The note as the server holds it now; null (saying so) when it can't be read. */
  async function loadServer(): Promise<NoteResponse | null> {
    setReloadProblem(false);
    try {
      return await fetchNote(studyId, note.id);
    } catch {
      setReloadProblem(true);
      return null;
    }
  }

  /** "Keep server version": the editor shows the server's note; this tab's text is dropped. */
  async function reloadLatest() {
    const fresh = server ?? (await loadServer());
    if (!fresh) return;
    queryClient.setQueryData(noteQueryKey(studyId, note.id), fresh);
    editor?.commands.setContent(fresh.content, { emitUpdate: false });
    saver.reset(fresh.revision, fresh.content);
    setCloseProblem(null);
  }

  /**
   * "Save my version" or "Save combined version": the editor's text, saved from the server's
   * current revision as a new version and logged as the conflict's resolution.
   */
  async function keepMine(resolution: NoteConflictResolution) {
    const fresh = server ?? (await loadServer());
    if (fresh) saver.keepMine(fresh.revision, resolution);
  }

  function restoreVersion(content: NoteDocument) {
    editor?.commands.setContent(content, { emitUpdate: false });
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

  /**
   * Resolves the selected text as a Bible reference (`POST /bible/resolve`, the same rules as the
   * reader) and, only when it resolves, replaces exactly that text with a verified reference
   * link. Nothing is guessed: an ambiguous book offers its candidates, anything else leaves the
   * text as it is. No node, edge or study event comes of it (FR-NOTE-003).
   */
  async function resolveSelection(
    range?: { from: number; to: number; text: string },
    input?: string,
  ) {
    if (!editor || resolving) return;
    const { from, to } = range ?? trimmedRange(editor.state.doc, editor.state.selection);
    const text = range?.text ?? editor.state.doc.textBetween(from, to, ' ', ' ');
    setResolveMessage(null);
    setCandidates(null);
    if (text === '') return setResolveMessage(RESOLVE_COPY.empty);
    if (text.length > MAX_SEARCH_QUERY_LENGTH) return setResolveMessage(RESOLVE_COPY.tooLong);
    setResolving(true);
    try {
      // Without a starting passage, the first active translation (asked for only now).
      const resolveEditionId =
        editionId ??
        (
          await queryClient.ensureQueryData({
            queryKey: TRANSLATIONS_QUERY_KEY,
            queryFn: fetchTranslations,
          })
        ).translations[0]?.id;
      if (!resolveEditionId) return setResolveMessage(RESOLVE_COPY.failed);
      const outcome = await resolveReference(input ?? text, resolveEditionId);
      // The note may have changed while the request was out: link only the same text.
      if (editor.state.doc.textBetween(from, to, ' ', ' ').trim() !== text) {
        return setResolveMessage(RESOLVE_COPY.changed);
      }
      if (outcome.outcome === 'resolved') {
        const { id, label } = outcome.reference;
        editor
          .chain()
          .focus()
          .insertContentAt({ from, to }, [
            { type: 'scriptureReference', attrs: { referenceId: id, label } },
          ])
          .run();
        setResolveMessage(`Linked ${label}.`);
      } else if (outcome.outcome === 'ambiguous') {
        setCandidates({ from, to, text, options: outcome.candidates });
      } else {
        setResolveMessage(RESOLVE_COPY.notReference);
      }
    } catch (error) {
      const kind = classifyError(error);
      setResolveMessage(
        kind.kind === 'reference' ? REFERENCE_ERROR_COPY[kind.code] : RESOLVE_COPY.failed,
      );
    } finally {
      setResolving(false);
    }
  }

  /**
   * Opens "Make node…" with the selected text (trimmed; blocks joined by a line break). Only a
   * note the server already holds is converted: while anything is unsaved it asks to wait.
   */
  function openMakeNode() {
    if (!editor || !writable) return;
    setActionMessage(null);
    if (unsaved) return setActionMessage(MAKE_NODE_COPY.unsaved);
    const { from, to } = trimmedRange(editor.state.doc, editor.state.selection);
    const text = editor.state.doc.textBetween(from, to, '\n', leafText);
    if (text.trim() === '') return setActionMessage(MAKE_NODE_COPY.noSelection);
    setMakeNode({ text });
  }

  function closeMakeNode(message: string | null) {
    setMakeNode(null);
    setActionMessage(message);
    makeNodeButton.current?.focus();
  }

  /** Inserts a mention of the chosen node at the selection (replacing any selected text). */
  function insertMention(node: { id: string; label: string }) {
    if (!editor || !writable) return;
    const { from, to } = editor.state.selection;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, [
        { type: 'nodeMention', attrs: { nodeId: node.id, label: node.label } },
      ])
      .run();
    setMentionOpen(false);
    setActionMessage(MENTION_COPY.inserted);
  }

  /** Closes the Link form unchanged (Cancel or Escape), back to the Link button that opened it. */
  function cancelLink() {
    setLinkOpen(false);
    setLinkError(null);
    linkButton.current?.focus();
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
      className="rounded border border-muted px-2 py-1 text-sm aria-pressed:border-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-canvas"
    >
      {label}
    </button>
  );

  // BIB-58: mentions of nodes deleted since (as the note was loaded), named by their labels.
  const deletedMentions = useMemo(() => {
    const deleted = new Set(note.deletedMentionNodeIds);
    const labels = new Map<string, string>();
    for (const mention of noteNodeMentions(note.content)) {
      if (deleted.has(mention.nodeId) && !labels.has(mention.nodeId)) {
        labels.set(mention.nodeId, mention.label);
      }
    }
    return [...labels.values()];
  }, [note.content, note.deletedMentionNodeIds]);

  const canSaveVersion =
    !stopped && state.kind !== 'too_long' && state.kind !== 'too_large' && state.kind !== 'invalid';
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
          ref={linkButton}
          type="button"
          aria-pressed={active?.link}
          aria-expanded={linkOpen}
          aria-controls={ids.link}
          onClick={() => {
            setLinkValue((editor?.getAttributes('link').href as string | undefined) ?? '');
            setLinkError(null);
            setLinkOpen((open) => !open);
          }}
          className="rounded border border-muted px-2 py-1 text-sm aria-pressed:border-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-canvas"
        >
          Link
        </button>
        <button
          type="button"
          aria-disabled={resolving || !writable ? true : undefined}
          onClick={() => {
            if (!resolving && writable) void resolveSelection();
          }}
          className="rounded border border-muted px-2 py-1 text-sm aria-disabled:opacity-60"
        >
          Resolve reference
        </button>
        <button
          ref={makeNodeButton}
          type="button"
          aria-disabled={!writable || unsaved || !active?.hasSelection ? true : undefined}
          aria-expanded={makeNode !== null}
          onClick={openMakeNode}
          className="rounded border border-muted px-2 py-1 text-sm aria-disabled:opacity-60"
        >
          {MAKE_NODE_COPY.button}
        </button>
        <button
          ref={mentionButton}
          type="button"
          aria-disabled={!writable ? true : undefined}
          aria-expanded={mentionOpen}
          onClick={() => {
            if (!writable) return;
            setActionMessage(null);
            setMentionOpen((open) => !open);
          }}
          className="rounded border border-muted px-2 py-1 text-sm aria-disabled:opacity-60"
        >
          {MENTION_COPY.button}
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
      {mentionOpen ? (
        <MentionNodeForm
          studyId={studyId}
          onInsert={insertMention}
          onCancel={() => {
            setMentionOpen(false);
            mentionButton.current?.focus();
          }}
        />
      ) : null}
      {makeNode ? (
        <MakeNodeForm
          studyId={studyId}
          studyRevision={studyRevision}
          noteId={note.id}
          initialText={makeNode.text}
          onCreated={(message) => closeMakeNode(message)}
          onCancel={() => closeMakeNode(null)}
          onReload={onReloadStudy}
        />
      ) : null}
      {linkOpen ? (
        <form
          id={ids.link}
          onSubmit={applyLink}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelLink();
            }
          }}
          className="flex flex-wrap items-end gap-2"
        >
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
            onClick={cancelLink}
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
      {deletedMentions.length > 0 ? (
        <p className="text-sm">
          {`This note mentions ${deletedMentions.length === 1 ? 'a node' : 'nodes'} deleted since: ${deletedMentions.join(', ')}.`}
        </p>
      ) : null}

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
        {state.kind === 'signed_out' ? (
          <>
            <a
              href={`/sign-in?next=${encodeURIComponent('/studies')}`}
              target="_blank"
              rel="noopener"
              className="text-accent underline"
            >
              Sign in again (opens a new tab)
            </a>
            <button
              type="button"
              onClick={() => saver.reconnected()}
              className="text-accent underline"
            >
              Retry
            </button>
          </>
        ) : null}
        {state.kind === 'locked' ? (
          <button type="button" onClick={onReloadStudy} className="text-accent underline">
            Reload
          </button>
        ) : null}
        {state.kind === 'queue_full' ? (
          <button type="button" onClick={downloadDraft} className="text-accent underline">
            Download draft
          </button>
        ) : null}
      </div>
      {tabs.elsewhere ? <p className="text-sm text-muted">{SAVE_COPY.otherTab}</p> : null}
      {state.kind === 'conflict' ? (
        <section aria-label="Resolve conflict" className="flex flex-col gap-3 rounded border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex flex-col gap-1">
              <figcaption className="text-sm font-medium">Your version</figcaption>
              <p className="whitespace-pre-wrap rounded border border-muted p-2 text-sm">
                {mineAtConflict}
              </p>
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-sm font-medium">Version saved elsewhere</figcaption>
              <p className="whitespace-pre-wrap rounded border border-muted p-2 text-sm">
                {server ? notePlainText(server.content) : 'Loading the saved version…'}
              </p>
            </figure>
          </div>
          {combining ? (
            <p className="text-sm">
              Edit your text in the note above, copying what you need from the version saved
              elsewhere, then choose Save combined version.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void reloadLatest()}
              className="rounded border border-muted px-3 py-1"
            >
              Keep server version
            </button>
            <button
              type="button"
              onClick={() => void keepMine('keep_mine')}
              className="rounded border border-muted px-3 py-1"
            >
              Save my version
            </button>
            {combining ? (
              <button
                type="button"
                onClick={() => void keepMine('combined')}
                className="rounded border border-accent px-3 py-1 text-accent"
              >
                Save combined version
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCombining(true);
                  editor?.commands.focus();
                }}
                className="rounded border border-muted px-3 py-1"
              >
                Combine manually
              </button>
            )}
          </div>
        </section>
      ) : null}
      {reloadProblem ? (
        <p role="alert" className="text-sm font-medium text-accent">
          Couldn&apos;t load the latest note. Your text is still here.
        </p>
      ) : null}

      {/* Polite: the outcome of Resolve reference (references only, never the typed text). */}
      <p role="status" aria-live="polite" className={resolveMessage ? 'text-sm' : 'sr-only'}>
        {resolving ? 'Checking the reference…' : (resolveMessage ?? '')}
      </p>
      {/* Polite: the outcome of Make node or Mention node (fixed copy, never the excerpt). */}
      <p role="status" aria-live="polite" className={actionMessage ? 'text-sm' : 'sr-only'}>
        {actionMessage ?? ''}
      </p>
      {candidates ? (
        <div role="group" aria-label="Choose the book" className="flex flex-col gap-2">
          <p className="text-sm">{RESOLVE_COPY.ambiguous}</p>
          <div className="flex flex-wrap gap-2">
            {candidates.options.map((option) => (
              <button
                key={option.bookCode}
                type="button"
                onClick={() =>
                  void resolveSelection(
                    { from: candidates.from, to: candidates.to, text: candidates.text },
                    option.input,
                  )
                }
                className="rounded border border-accent px-2 py-1 text-sm text-accent"
              >
                {option.bookName}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setCandidates(null);
                editor?.commands.focus();
              }}
              className="rounded border border-muted px-2 py-1 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
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
          onClick={() => {
            if (!closing) void close().then((ok) => ok && onClose());
          }}
          className="rounded border border-muted px-3 py-1"
        >
          {closing ? 'Saving, then closing…' : 'Close note'}
        </button>
      </div>
      {closeProblem ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-accent">
            {closeProblem} {stateText(state)}
          </p>
          <button type="button" onClick={discardAndClose} className="text-accent underline">
            Close without saving
          </button>
        </div>
      ) : null}
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
