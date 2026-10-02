import {
  MAX_ORDERED_LIST_START,
  NOTE_TEXT_INVALID,
  NOTE_TOO_DEEP,
  NOTE_TOO_MANY_NODES,
  NOTE_TOO_MANY_REFERENCES,
  type NoteDocument,
  noteDocumentSchema,
} from '@bible-artisan/contracts';

/** The JSON Tiptap's `editor.getJSON()` returns (a loose ProseMirror node). */
interface EditorNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/**
 * Why a note's content can't be saved as it is, so the editor can say which kind of content is
 * the problem (the server stays strict; the client normalizes what it safely can first).
 */
export type NoteContentProblem =
  | 'link'
  | 'list_numbering'
  | 'characters'
  | 'too_deep'
  | 'too_many_parts'
  /** A Bible reference link the server could not verify (BIB-24, 422 NOTE_REFERENCE_INVALID). */
  | 'reference'
  | 'structure';

/** The editor's content as the API takes it, or why it can't be saved. */
export type NoteDraft =
  { ok: true; doc: NoteDocument } | { ok: false; problem: NoteContentProblem };

/**
 * C0 control characters but tab and lone surrogates: what the allowlist refuses in text. A line
 * break inside a run is one of them (the editor makes paragraphs and hard breaks, never `\n`).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000A-\u001F]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as a note can hold it: each control character (a pasted vertical tab, form feed, NUL or
 * stray carriage return) becomes a space, and an unpaired surrogate the replacement character.
 * Ordinary text, tabs and emoji are untouched.
 */
export function cleanNoteText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(LONE_SURROGATES, '�');
}

/**
 * An ordered list's `start` as the allowlist takes it: 1 to `MAX_ORDERED_LIST_START`. Tiptap's
 * input rule makes `start: 0` from "0. " and any number from "123456. "; 1 (the default) and
 * anything that is not a positive whole number are left out, a larger one is clamped.
 */
function listStart(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 1) return undefined;
  return Math.min(value, MAX_ORDERED_LIST_START);
}

function keptAttrs(type: string, attrs: Record<string, unknown> | undefined) {
  if (!attrs) return undefined;
  switch (type) {
    case 'heading':
      return attrs.level === undefined || attrs.level === null ? undefined : { level: attrs.level };
    case 'orderedList': {
      const start = listStart(attrs.start);
      return start === undefined ? undefined : { start };
    }
    case 'link':
      return attrs.href === undefined || attrs.href === null ? undefined : { href: attrs.href };
    case 'scriptureReference':
      // Exactly what the allowlist carries; the server verifies both against the corpus.
      return { referenceId: attrs.referenceId, label: attrs.label };
    default:
      return undefined;
  }
}

function normalize(node: EditorNode): EditorNode | null {
  const type = node.type ?? '';
  const attrs = keptAttrs(type, node.attrs);
  let text: string | undefined;
  if (node.text !== undefined) {
    text = cleanNoteText(node.text);
    // An empty run is never valid; a run that was only removed characters goes.
    if (text === '') return null;
  }
  const content = node.content
    ?.map(normalize)
    .filter((child): child is EditorNode => child !== null);
  return {
    type,
    ...(attrs ? { attrs } : {}),
    ...(text !== undefined ? { text } : {}),
    // A reference link carries no marks (the allowlist refuses them); its editor node allows
    // none, and any that arrive anyway are dropped rather than making the note unsavable.
    ...(node.marks && node.marks.length > 0 && type !== 'scriptureReference'
      ? {
          marks: node.marks.map((mark) => {
            const markAttrs = keptAttrs(mark.type, mark.attrs);
            return { type: mark.type, ...(markAttrs ? { attrs: markAttrs } : {}) };
          }),
        }
      : {}),
    ...(content && content.length > 0 ? { content } : {}),
  };
}

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

/** Which kind of content the allowlist refused, from its issues (client or server). */
export function classifyNoteIssues(issues: readonly Issue[]): NoteContentProblem {
  for (const { path, message } of issues) {
    if (message === NOTE_TOO_DEEP) return 'too_deep';
    if (message === NOTE_TOO_MANY_NODES) return 'too_many_parts';
    if (message === NOTE_TEXT_INVALID) return 'characters';
    if (message === NOTE_TOO_MANY_REFERENCES || path.includes('referenceId')) return 'reference';
    if (path.includes('href')) return 'link';
    if (path.includes('start')) return 'list_numbering';
  }
  return 'structure';
}

/** The same, from a 400's `fieldErrors` (keys are issue paths joined with dots). */
export function classifyNoteFieldErrors(fieldErrors: unknown): NoteContentProblem {
  if (fieldErrors === null || typeof fieldErrors !== 'object') return 'structure';
  return classifyNoteIssues(
    Object.entries(fieldErrors as Record<string, unknown>).flatMap(([key, messages]) =>
      (Array.isArray(messages) ? messages : []).map((message) => ({
        path: key.split('.'),
        message: String(message),
      })),
    ),
  );
}

/**
 * The editor's document as the API takes it (BIB-23). Tiptap's own attributes the allowlist does
 * not carry (a link's `target`/`rel`/`class`/`title`, an ordered list's `type`) are dropped, an
 * ordered list's `start` is brought into range, and control characters in text become spaces;
 * then the result must pass the same `noteDocumentSchema` the server applies. What still fails
 * (a link that is not a web address, nesting too deep) is reported by kind, and nothing is sent.
 */
export function toNoteDraft(json: unknown): NoteDraft {
  if (json === null || typeof json !== 'object') return { ok: false, problem: 'structure' };
  const parsed = noteDocumentSchema.safeParse(normalize(json));
  return parsed.success
    ? { ok: true, doc: parsed.data }
    : { ok: false, problem: classifyNoteIssues(parsed.error.issues) };
}

/** `toNoteDraft`'s document, or null when it can't be saved. */
export function toNoteDocument(json: unknown): NoteDocument | null {
  const draft = toNoteDraft(json);
  return draft.ok ? draft.doc : null;
}
