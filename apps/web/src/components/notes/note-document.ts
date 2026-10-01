import { type NoteDocument, noteDocumentSchema } from '@bible-artisan/contracts';

/** The JSON Tiptap's `editor.getJSON()` returns (a loose ProseMirror node). */
interface EditorNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** The attributes the note allowlist keeps per node or mark type; Tiptap adds others. */
const KEPT_ATTRS: Record<string, readonly string[]> = {
  heading: ['level'],
  orderedList: ['start'],
  link: ['href'],
};

function keptAttrs(type: string, attrs: Record<string, unknown> | undefined) {
  const names = KEPT_ATTRS[type];
  if (!names || !attrs) return undefined;
  const kept: Record<string, unknown> = {};
  for (const name of names)
    if (attrs[name] !== undefined && attrs[name] !== null) kept[name] = attrs[name];
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function normalize(node: EditorNode): EditorNode {
  const type = node.type ?? '';
  const attrs = keptAttrs(type, node.attrs);
  return {
    type,
    ...(attrs ? { attrs } : {}),
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks && node.marks.length > 0
      ? {
          marks: node.marks.map((mark) => {
            const markAttrs = keptAttrs(mark.type, mark.attrs);
            return { type: mark.type, ...(markAttrs ? { attrs: markAttrs } : {}) };
          }),
        }
      : {}),
    ...(node.content && node.content.length > 0 ? { content: node.content.map(normalize) } : {}),
  };
}

/**
 * The editor's document as the API takes it (BIB-23): Tiptap's own attributes the allowlist does
 * not carry (a link's `target`/`rel`/`class`/`title`, an ordered list's `type`) are dropped, and
 * the result must pass the same `noteDocumentSchema` the server applies. Anything the allowlist
 * refuses (which the restricted editor should never produce) is null: the note is not sent, and
 * the editor says it cannot be saved. Nothing is silently rewritten into something else.
 */
export function toNoteDocument(json: unknown): NoteDocument | null {
  if (json === null || typeof json !== 'object') return null;
  const parsed = noteDocumentSchema.safeParse(normalize(json));
  return parsed.success ? parsed.data : null;
}
