import { z } from 'zod';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { STUDY_NODE_TYPES } from './study';
import { tagKey } from './study-edit';
import { httpUrlSchema } from './url';

/**
 * Rich notes (BIB-23; PRD sections 15, 23, 24, 29; FR-NOTE-001/002/004, NFR-SEC-002).
 *
 * A note's content is a Tiptap/ProseMirror JSON document checked against an explicit allowlist:
 * every node, mark and attribute below is the whole of what is accepted, and every object is
 * strict, so anything else (an unknown node such as `image` or `codeBlock`, an unknown mark, a
 * link `target`/`rel`/`class`, HTML of any kind) is refused, never stripped or repaired. The
 * server validates every write with this schema and derives the plain text itself; the web
 * client parses every note it receives with it too.
 */

/** PRD section 15: "Notes are limited to 50,000 characters of derived text" (code points). */
export const MAX_NOTE_CHARACTERS = 50_000;
/** Deepest nesting of document nodes, counting `doc` as 1 (lists in lists in quotes, …). */
export const MAX_NOTE_DEPTH = 12;
/** Most document nodes (blocks, list items, text runs, hard breaks) in one note. */
export const MAX_NOTE_NODES = 20_000;
/** Largest JSON body the note routes accept; any larger request is 413 before parsing. */
export const MAX_NOTE_BODY_BYTES = 1_048_576;
/**
 * Live notes one study may hold (the note trash does not count: trashing a note makes room, and
 * restoring one needs room). Each note list (live, or the trash) is one unpaginated response of
 * at most this many notes.
 */
export const MAX_NOTES_PER_STUDY = 1000;
/** PRD section 15: checkpoint versions are "capped at 100 versions per note". */
export const MAX_NOTE_VERSIONS = 100;
/** PRD section 15: while editing, a version is saved at most every 30 seconds. */
export const NOTE_CHECKPOINT_INTERVAL_SECONDS = 30;
/** Code points of plain text a list item previews. */
export const NOTE_PREVIEW_LENGTH = 200;
/** Largest `start` an ordered list may declare. */
export const MAX_ORDERED_LIST_START = 10_000;
/** Version of the document schema stored with each note and version. */
export const NOTE_SCHEMA_VERSION = 1;

/** 413: the derived plain text is longer than `MAX_NOTE_CHARACTERS`. */
export const NOTE_TOO_LONG = 'NOTE_TOO_LONG';
/** 422: `targetNodeId` is not a live node of this study. */
export const NOTE_TARGET_NOT_FOUND = 'NOTE_TARGET_NOT_FOUND';
/** 422: the study already holds `MAX_NOTES_PER_STUDY` live notes (create, or restore from trash). */
export const NOTE_LIMIT_EXCEEDED = 'NOTE_LIMIT_EXCEEDED';
/** 422: the edit changes nothing (same content, and no new version to save). */
export const NOTE_UNCHANGED = 'NOTE_UNCHANGED';
/** 422: the note is in the trash (edit or trash again), so the change cannot apply. */
export const NOTE_TRASHED = 'NOTE_TRASHED';
/** 422: restore of a note that is not in the trash. */
export const NOTE_NOT_TRASHED = 'NOTE_NOT_TRASHED';

export const NOTE_ERROR_CODES = [
  NOTE_TARGET_NOT_FOUND,
  NOTE_LIMIT_EXCEEDED,
  NOTE_UNCHANGED,
  NOTE_TRASHED,
  NOTE_NOT_TRASHED,
] as const;
export type NoteErrorCode = (typeof NOTE_ERROR_CODES)[number];

/** Field-error copy. Fixed: never the submitted content. */
export const NOTE_TOO_DEEP = `A note can nest at most ${MAX_NOTE_DEPTH} levels`;
export const NOTE_TOO_MANY_NODES = `A note can have at most ${MAX_NOTE_NODES.toLocaleString('en-US')} elements`;
export const NOTE_TEXT_INVALID = 'Remove control or invalid characters';
export const NOTE_MARK_REPEATED = 'Each formatting mark may appear once per text run';
export const NOTE_EDIT_EMPTY = 'Send new content or ask for a checkpoint';

// ---------------------------------------------------------------------------------------------
// The document allowlist
// ---------------------------------------------------------------------------------------------

export type NoteMark =
  { type: 'bold' } | { type: 'italic' } | { type: 'link'; attrs: { href: string } };

export interface NoteText {
  type: 'text';
  text: string;
  marks?: NoteMark[];
}

export interface NoteHardBreak {
  type: 'hardBreak';
}

export type NoteInline = NoteText | NoteHardBreak;

export interface NoteParagraph {
  type: 'paragraph';
  content?: NoteInline[];
}

export interface NoteHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 };
  content?: NoteInline[];
}

export interface NoteBlockquote {
  type: 'blockquote';
  content: NoteBlock[];
}

/** A list item is a paragraph, then any further blocks (a nested list, another paragraph). */
export interface NoteListItem {
  type: 'listItem';
  content: [NoteParagraph, ...NoteBlock[]];
}

export interface NoteBulletList {
  type: 'bulletList';
  content: NoteListItem[];
}

export interface NoteOrderedList {
  type: 'orderedList';
  attrs?: { start: number };
  content: NoteListItem[];
}

export type NoteBlock =
  NoteParagraph | NoteHeading | NoteBlockquote | NoteBulletList | NoteOrderedList;

export interface NoteDocument {
  type: 'doc';
  content: NoteBlock[];
}

/**
 * Text of one run: non-empty, no C0 control character but tab (a line break is a `hardBreak`
 * node, never a character), no U+0000, no unpaired surrogate. PostgreSQL `jsonb` refuses U+0000.
 */
const FORBIDDEN_NOTE_TEXT =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000A-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const noteTextRunSchema = z
  .string()
  .min(1)
  // No length bound per run: the request body is bounded, and the note's whole plain text is
  // checked against MAX_NOTE_CHARACTERS (413 NOTE_TOO_LONG) once derived.
  .refine((text) => !FORBIDDEN_NOTE_TEXT.test(text), { message: NOTE_TEXT_INVALID });

const noteMarkSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  // Only http(s) URLs without credentials or embedded whitespace/control characters (BIB-11).
  z.strictObject({ type: z.literal('link'), attrs: z.strictObject({ href: httpUrlSchema }) }),
]);

const noteTextSchema = z.strictObject({
  type: z.literal('text'),
  text: noteTextRunSchema,
  marks: z
    .array(noteMarkSchema)
    .max(3)
    .refine((marks) => new Set(marks.map((mark) => mark.type)).size === marks.length, {
      message: NOTE_MARK_REPEATED,
    })
    .optional(),
});

const noteInlineSchema = z.discriminatedUnion('type', [
  noteTextSchema,
  z.strictObject({ type: z.literal('hardBreak') }),
]);

const noteParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(noteInlineSchema).optional(),
});

const noteHeadingSchema = z.strictObject({
  type: z.literal('heading'),
  attrs: z.strictObject({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  content: z.array(noteInlineSchema).optional(),
});

// Named (`meta({ id })`) so the generated OpenAPI document can refer to the recursive schemas as
// components (`openapi.ts` hoists them).
const noteBlockSchema: z.ZodType<NoteBlock> = z
  .lazy(() =>
    z.discriminatedUnion('type', [
      noteParagraphSchema,
      noteHeadingSchema,
      z.strictObject({ type: z.literal('blockquote'), content: z.array(noteBlockSchema).min(1) }),
      z.strictObject({
        type: z.literal('bulletList'),
        content: z.array(noteListItemSchema).min(1),
      }),
      z.strictObject({
        type: z.literal('orderedList'),
        attrs: z
          .strictObject({ start: z.number().int().min(1).max(MAX_ORDERED_LIST_START) })
          .optional(),
        content: z.array(noteListItemSchema).min(1),
      }),
    ]),
  )
  .meta({ id: 'NoteBlock' });

const noteListItemSchema: z.ZodType<NoteListItem> = z
  .lazy(() =>
    z.strictObject({
      type: z.literal('listItem'),
      content: z.tuple([noteParagraphSchema], noteBlockSchema),
    }),
  )
  .meta({ id: 'NoteListItem' });

/**
 * Bounds checked on the raw JSON before the structural schema runs, without recursion, so a
 * hostile body (thousands of nested arrays, a million tiny objects) is refused cheaply and can
 * never exhaust the stack. A document node at nesting level n sits at JSON depth 2n − 1, and a
 * link's `attrs` three levels below its text node, so `MAX_RAW_DEPTH` admits every valid
 * document; the exact node depth and count are checked after parsing.
 */
const MAX_RAW_DEPTH = 2 * MAX_NOTE_DEPTH + 2;
const MAX_RAW_CONTAINERS = 4 * MAX_NOTE_NODES;

function rawBoundsProblem(value: unknown): string | null {
  const stack: [unknown, number][] = [[value, 1]];
  let containers = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (current === null || typeof current !== 'object') continue;
    containers += 1;
    if (depth > MAX_RAW_DEPTH) return NOTE_TOO_DEEP;
    if (containers > MAX_RAW_CONTAINERS) return NOTE_TOO_MANY_NODES;
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return null;
}

/** The deepest nesting level and the number of document nodes (`doc` included). */
function measure(doc: NoteDocument): { depth: number; nodes: number } {
  let depth = 0;
  let nodes = 0;
  const stack: [{ content?: readonly unknown[] }, number][] = [[doc, 1]];
  while (stack.length > 0) {
    const [node, level] = stack.pop() as [{ content?: readonly unknown[] }, number];
    nodes += 1;
    depth = Math.max(depth, level);
    for (const child of node.content ?? []) {
      stack.push([child as { content?: readonly unknown[] }, level + 1]);
    }
  }
  return { depth, nodes };
}

const noteDocumentShapeSchema = z
  .strictObject({ type: z.literal('doc'), content: z.array(noteBlockSchema).min(1) })
  .superRefine((doc, ctx) => {
    const { depth, nodes } = measure(doc);
    if (depth > MAX_NOTE_DEPTH) ctx.addIssue({ code: 'custom', message: NOTE_TOO_DEEP });
    else if (nodes > MAX_NOTE_NODES) {
      ctx.addIssue({ code: 'custom', message: NOTE_TOO_MANY_NODES });
    }
  });

/**
 * A note document. The raw bounds run first; the structural allowlist only runs on input that
 * passed them (a failed check stops the pipe).
 */
export const noteDocumentSchema: z.ZodType<NoteDocument> = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = rawBoundsProblem(value);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, abort: true });
  })
  .pipe(noteDocumentShapeSchema);

/** What a new note starts as: one empty paragraph (Tiptap's empty document). */
export const EMPTY_NOTE_DOCUMENT: NoteDocument = { type: 'doc', content: [{ type: 'paragraph' }] };

// ---------------------------------------------------------------------------------------------
// Derived text
// ---------------------------------------------------------------------------------------------

function inlineText(content: readonly NoteInline[] | undefined): string {
  return (content ?? []).map((node) => (node.type === 'text' ? node.text : '\n')).join('');
}

function blocksText(blocks: readonly NoteBlock[]): string {
  return blocks.map(blockText).join('\n');
}

function blockText(block: NoteBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.content);
    case 'blockquote':
      return blocksText(block.content);
    case 'bulletList':
    case 'orderedList':
      return block.content.map((item) => blocksText(item.content)).join('\n');
  }
}

/**
 * The note's plain text, as the server stores it for search, previews, export and the length
 * limit: text runs in order, a line break for each hard break and between blocks and list items.
 * Formatting and link targets are not part of it. Only the server's copy is stored; the web
 * client uses the same function for its character counter.
 */
export function notePlainText(doc: NoteDocument): string {
  return blocksText(doc.content);
}

/** Characters as the limit counts them: Unicode code points (an emoji is one). */
export function noteCharacterCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The first `NOTE_PREVIEW_LENGTH` code points of the text, whitespace runs collapsed. */
export function notePreview(plainText: string): string {
  return Array.from(plainText.replace(/\s+/gu, ' ').trim()).slice(0, NOTE_PREVIEW_LENGTH).join('');
}

/**
 * `note.search_text`: the plain text folded exactly like library search words (`tagKey`), so the
 * library matches a word typed in any case or compatibility form (BIB-21's literal `strpos`).
 */
export function noteSearchText(plainText: string): string {
  return tagKey(plainText);
}

// ---------------------------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/studies/:studyId/notes`. Creating a note is a change to the study, so
 * `expectedRevision` is the study's revision. No `targetNodeId`: a study note.
 */
export const createNoteRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  targetNodeId: z.uuid().optional(),
  content: noteDocumentSchema,
});

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

/**
 * `PATCH /v1/studies/:studyId/notes/:noteId`. `expectedRevision` is the note's. `checkpoint: true`
 * asks for a version of the resulting content (the editor's "Save version"); without it the
 * server keeps a version at most every `NOTE_CHECKPOINT_INTERVAL_SECONDS` while content changes.
 */
export const updateNoteRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    content: noteDocumentSchema.optional(),
    checkpoint: z.literal(true).optional(),
  })
  .refine((body) => body.content !== undefined || body.checkpoint !== undefined, {
    message: NOTE_EDIT_EMPTY,
  });

export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

/** `DELETE …/notes/:noteId` (trash) and `POST …/notes/:noteId/restore`: the note's revision. */
export const noteStateRequestSchema = z.strictObject({ expectedRevision: expectedRevisionSchema });

export const NOTE_LIST_STATES = ['active', 'trashed'] as const;
export type NoteListState = (typeof NOTE_LIST_STATES)[number];

/** `GET /v1/studies/:studyId/notes?state=`: live notes (default) or the note trash. */
export const listNotesQuerySchema = z.strictObject({
  state: z.enum(NOTE_LIST_STATES).default('active'),
});

/**
 * The node a note is attached to. `label` is what identifies it to the owner: a question's text,
 * a Scripture node's reference label; null for a type without one yet. `deleted`: the node was
 * deleted, so the note is listed for orphaned-note review (FR-NOTE-002); it keeps its target.
 */
export const noteTargetSchema = z.object({
  nodeId: z.uuid(),
  nodeType: z.enum(STUDY_NODE_TYPES),
  label: z.string().nullable(),
  deleted: z.boolean(),
});

export type NoteTarget = z.infer<typeof noteTargetSchema>;

/** One note with its content. `target` is null for a study note. */
export const noteResponseSchema = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  revision: z.number().int().positive(),
  target: noteTargetSchema.nullable(),
  content: noteDocumentSchema,
  characterCount: z.number().int().nonnegative(),
  latestVersionNumber: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** When the note was moved to the trash; null for a live note. */
  deletedAt: z.iso.datetime().nullable(),
});

export type NoteResponse = z.infer<typeof noteResponseSchema>;

/**
 * 200 from `PATCH`, `DELETE` (trash) and `POST …/restore`: the note's new state without its
 * content or target label. The client already holds the content it sent, and every mutation
 * response is stored on its Idempotency-Key receipt for replay, so leaving the text out keeps
 * note bodies off `mutation_receipt` entirely.
 */
export const noteMutationResponseSchema = z.object({
  id: z.uuid(),
  studyId: z.uuid(),
  revision: z.number().int().positive(),
  targetNodeId: z.uuid().nullable(),
  characterCount: z.number().int().nonnegative(),
  latestVersionNumber: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  lastEventSequence: eventSequenceSchema,
});

export type NoteMutationResponse = z.infer<typeof noteMutationResponseSchema>;

/**
 * 201 from `POST …/notes`: as above, plus the study revision the creation moved to (creating a
 * note is a study change), so the client keeps its copy of the study current.
 */
export const createNoteResponseSchema = noteMutationResponseSchema.extend({
  studyRevision: z.number().int().positive(),
});

export type CreateNoteResponse = z.infer<typeof createNoteResponseSchema>;

export const noteSummarySchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  target: noteTargetSchema.nullable(),
  preview: z.string(),
  characterCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

export type NoteSummary = z.infer<typeof noteSummarySchema>;

/**
 * Most recently updated first (ties by id). At most `MAX_NOTES_PER_STUDY`: every live note, or
 * the most recently trashed notes of the note trash.
 */
export const noteListResponseSchema = z.object({ items: z.array(noteSummarySchema) });

export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

export const noteVersionSummarySchema = z.object({
  id: z.uuid(),
  versionNumber: z.number().int().positive(),
  preview: z.string(),
  characterCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export type NoteVersionSummary = z.infer<typeof noteVersionSummarySchema>;

/** Newest first; at most `MAX_NOTE_VERSIONS`. */
export const noteVersionListResponseSchema = z.object({
  items: z.array(noteVersionSummarySchema),
});

export type NoteVersionListResponse = z.infer<typeof noteVersionListResponseSchema>;

export const noteVersionResponseSchema = z.object({
  id: z.uuid(),
  noteId: z.uuid(),
  versionNumber: z.number().int().positive(),
  content: noteDocumentSchema,
  characterCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export type NoteVersionResponse = z.infer<typeof noteVersionResponseSchema>;
