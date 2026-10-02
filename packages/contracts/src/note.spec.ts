import { describe, expect, it } from 'vitest';
import {
  createNoteRequestSchema,
  MAX_NOTE_DEPTH,
  MAX_NOTE_NODES,
  MAX_NOTE_REFERENCES,
  NOTE_EDIT_EMPTY,
  NOTE_MARK_REPEATED,
  NOTE_TARGET_EXCLUSIVE,
  NOTE_TEXT_INVALID,
  NOTE_TOO_DEEP,
  NOTE_TOO_MANY_NODES,
  NOTE_TOO_MANY_REFERENCES,
  type NoteParagraph,
  noteCharacterCount,
  type NoteDocument,
  noteDocumentSchema,
  notePlainText,
  notePreview,
  noteReferenceLinks,
  noteSearchText,
  updateNoteRequestSchema,
} from './note';

const para = (text: string): NoteParagraph => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });
const link = (href: string): unknown =>
  doc({
    type: 'paragraph',
    content: [{ type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href } }] }],
  });

/** Every construct the editor offers, as Tiptap emits it once normalized. */
const FULL: NoteDocument = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Conscience' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'hardBreak' },
        {
          type: 'text',
          text: 'a link',
          marks: [{ type: 'link', attrs: { href: 'https://example.org/a?b=c#d' } }],
        },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 3 },
      content: [
        {
          type: 'listItem',
          content: [
            para('first'),
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [para('nested')] }],
            },
          ],
        },
      ],
    },
    { type: 'blockquote', content: [para('quoted'), para('λόγος 🙂')] },
    { type: 'paragraph' },
  ],
};

/**
 * A document whose deepest node (a text run) is at nesting level `levels` (doc = 1): blockquotes
 * around one paragraph.
 */
function nested(levels: number): unknown {
  let block: unknown = para('deep');
  for (let level = 2; level < levels - 1; level += 1) {
    block = { type: 'blockquote', content: [block] };
  }
  return doc(block);
}

function issues(value: unknown): string[] {
  const result = noteDocumentSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('noteDocumentSchema (BIB-23, NFR-SEC-002)', () => {
  it('accepts every supported construct unchanged', () => {
    expect(noteDocumentSchema.parse(FULL)).toStrictEqual(FULL);
  });

  it.each([
    ['an unknown block node', doc({ type: 'image', attrs: { src: 'https://x.test/a.png' } })],
    ['raw HTML', doc({ type: 'html', content: '<script>alert(1)</script>' })],
    ['a script node', doc({ type: 'script', text: 'alert(1)' })],
    ['a code block', doc({ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] })],
    ['a horizontal rule', doc({ type: 'horizontalRule' })],
    [
      'an unknown mark',
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }] }] }),
    ],
    [
      'a script-like mark',
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'script', attrs: { src: 'x' } }] }],
      }),
    ],
    [
      'an extra attribute on a link',
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'x',
            marks: [{ type: 'link', attrs: { href: 'https://x.test', target: '_self' } }],
          },
        ],
      }),
    ],
    [
      'an event-handler attribute',
      doc({ type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [] }),
    ],
    ['an extra key on the document', { type: 'doc', content: [para('x')], html: '<b>' }],
    ['a heading level 4', doc({ type: 'heading', attrs: { level: 4 } })],
    ['a heading without a level', doc({ type: 'heading' })],
    [
      'an ordered list starting at 0',
      doc({
        type: 'orderedList',
        attrs: { start: 0 },
        content: [{ type: 'listItem', content: [para('x')] }],
      }),
    ],
    [
      'a list item not starting with a paragraph',
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'blockquote', content: [para('x')] }] }],
      }),
    ],
    ['an empty list', doc({ type: 'bulletList', content: [] })],
    ['an empty document', { type: 'doc', content: [] }],
    ['text directly in the document', doc({ type: 'text', text: 'x' })],
    ['an empty text run', doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] })],
    ['a non-object', 'just a string'],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(noteDocumentSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['JavaScript: in mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript: behind leading spaces', '   javascript:alert(1)'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a newline inside the URL', 'https://x.test/\nfoo'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///etc/passwd'],
    ['a protocol-relative URL', '//evil.test/x'],
    ['a relative URL', '/studies/x'],
    ['credentials', 'https://user:pass@evil.test/'],
    ['an empty href', ''],
  ])('refuses a link with %s', (_label, href) => {
    expect(noteDocumentSchema.safeParse(link(href)).success).toBe(false);
  });

  it('accepts http and https links', () => {
    expect(noteDocumentSchema.safeParse(link('http://example.org')).success).toBe(true);
    expect(
      noteDocumentSchema.safeParse(link('https://example.org/a b'.replace(' ', '%20'))).success,
    ).toBe(true);
  });

  it.each([
    ['U+0000', 'a\u0000b'],
    ['a line feed (line breaks are hardBreak nodes)', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['an escape character', 'a\u001bb'],
    ['an unpaired surrogate', 'a\ud800b'],
  ])('refuses text containing %s', (_label, text) => {
    expect(issues(doc({ type: 'paragraph', content: [{ type: 'text', text }] }))).toStrictEqual([
      NOTE_TEXT_INVALID,
    ]);
  });

  it('allows a tab in text', () => {
    expect(issues(doc(para('a\tb')))).toStrictEqual([]);
  });

  it('refuses a repeated mark on one text run', () => {
    expect(
      issues(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'bold' }] }],
        }),
      ),
    ).toStrictEqual([NOTE_MARK_REPEATED]);
  });

  it(`accepts ${MAX_NOTE_DEPTH} nesting levels and refuses ${MAX_NOTE_DEPTH + 1}`, () => {
    expect(issues(nested(MAX_NOTE_DEPTH))).toStrictEqual([]);
    expect(issues(nested(MAX_NOTE_DEPTH + 1))).toStrictEqual([NOTE_TOO_DEEP]);
  });

  it('refuses hostile nesting from the raw bounds alone, without recursing into it', () => {
    let value: unknown = [];
    for (let i = 0; i < 200_000; i += 1) value = [value];
    expect(issues(doc(value))).toStrictEqual([NOTE_TOO_DEEP]);
  });

  it(`accepts ${MAX_NOTE_NODES} nodes and refuses one more`, () => {
    // doc + one paragraph + its runs: hard breaks are the cheapest nodes.
    const runs = (n: number) => Array.from({ length: n }, () => ({ type: 'hardBreak' }));
    expect(issues(doc({ type: 'paragraph', content: runs(MAX_NOTE_NODES - 2) }))).toStrictEqual([]);
    expect(issues(doc({ type: 'paragraph', content: runs(MAX_NOTE_NODES - 1) }))).toStrictEqual([
      NOTE_TOO_MANY_NODES,
    ]);
  });

  it('refuses a flood of tiny objects from the raw bounds', () => {
    const flood = Array.from({ length: 100_000 }, () => ({}));
    expect(issues(doc({ type: 'paragraph', content: flood }))).toStrictEqual([NOTE_TOO_MANY_NODES]);
  });
});

describe('derived text', () => {
  it('joins blocks and list items with line breaks and turns hard breaks into line breaks', () => {
    expect(notePlainText(FULL)).toBe(
      ['Conscience', 'Bold both\na link', 'first', 'nested', 'quoted', 'λόγος 🙂', ''].join('\n'),
    );
  });

  it('counts code points, so an astral character is one', () => {
    expect(noteCharacterCount('a🙂λ')).toBe(3);
    expect(noteCharacterCount('')).toBe(0);
  });

  it('previews the first 200 code points with whitespace collapsed', () => {
    expect(notePreview('  one\n\ntwo\tthree ')).toBe('one two three');
    expect(notePreview('🙂'.repeat(250))).toBe('🙂'.repeat(200));
  });

  it('folds search text like library search words', () => {
    expect(noteSearchText('ΛΌΓΟΣ\nConscience')).toBe('λόγοσ conscience');
  });
});

describe('note requests', () => {
  it('needs a document on create and accepts a target node id', () => {
    const body = {
      expectedRevision: 1,
      content: FULL,
      targetNodeId: '0b8e9a3e-2f5f-4c3e-9a51-2f1d3c4b5a69',
    };
    expect(createNoteRequestSchema.parse(body)).toStrictEqual(body);
    expect(createNoteRequestSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    // Strict: the client never sends plain text or anything else the server derives.
    expect(
      createNoteRequestSchema.safeParse({ expectedRevision: 1, content: FULL, plainText: 'x' })
        .success,
    ).toBe(false);
  });

  it('needs content or a checkpoint on update', () => {
    const empty = updateNoteRequestSchema.safeParse({ expectedRevision: 2 });
    expect(empty.success ? [] : empty.error.issues.map((issue) => issue.message)).toStrictEqual([
      NOTE_EDIT_EMPTY,
    ]);
    expect(
      updateNoteRequestSchema.safeParse({ expectedRevision: 2, checkpoint: true }).success,
    ).toBe(true);
    expect(
      updateNoteRequestSchema.safeParse({ expectedRevision: 2, checkpoint: false }).success,
    ).toBe(false);
  });
});

describe('verified reference links and Scripture targets (BIB-24)', () => {
  const REF = '0b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  const refNode = (attrs: object): unknown => ({ type: 'scriptureReference', attrs });
  const withRef = (...inline: unknown[]): unknown => doc({ type: 'paragraph', content: inline });
  const ANCHOR = {
    version: 1,
    editionId: '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    bookCode: 'ROM',
    kind: 'phrase',
    segments: [{ chapter: 9, verse: 1, start: 0, end: 6, textSha256: 'a'.repeat(64) }],
    quote: 'I tell',
  };

  it('accepts a scriptureReference inline node with exactly an id and a label, and derives its label as text', () => {
    const parsed = noteDocumentSchema.parse(
      withRef({ type: 'text', text: 'See ' }, refNode({ referenceId: REF, label: 'Romans 9:1' }), {
        type: 'text',
        text: '.',
      }),
    );
    expect(notePlainText(parsed)).toBe('See Romans 9:1.');
    expect(noteReferenceLinks(parsed)).toStrictEqual([{ referenceId: REF, label: 'Romans 9:1' }]);
  });

  it('refuses extra attributes, marks, content, a malformed id or an unsafe label', () => {
    for (const bad of [
      refNode({ referenceId: REF, label: 'Romans 9:1', href: 'javascript:alert(1)' }),
      { ...(refNode({ referenceId: REF, label: 'Romans 9:1' }) as object), marks: [] },
      { ...(refNode({ referenceId: REF, label: 'Romans 9:1' }) as object), content: [] },
      refNode({ referenceId: 'Romans 9:1', label: 'Romans 9:1' }),
      refNode({ referenceId: REF, label: '' }),
      refNode({ referenceId: REF, label: 'Romans\n9:1' }),
      refNode({ referenceId: REF }),
    ]) {
      expect(noteDocumentSchema.safeParse(withRef(bad)).success).toBe(false);
    }
  });

  it(`accepts ${MAX_NOTE_REFERENCES} reference links and refuses one more`, () => {
    const refs = (n: number) =>
      withRef(
        ...Array.from({ length: n }, () => refNode({ referenceId: REF, label: 'Romans 9:1' })),
      );
    expect(noteDocumentSchema.safeParse(refs(MAX_NOTE_REFERENCES)).success).toBe(true);
    const over = noteDocumentSchema.safeParse(refs(MAX_NOTE_REFERENCES + 1));
    expect(over.error?.issues.map((i) => i.message)).toStrictEqual([NOTE_TOO_MANY_REFERENCES]);
  });

  it('takes a Scripture target on create, but never together with a node target', () => {
    const body = { expectedRevision: 1, content: doc(para('x')) };
    expect(createNoteRequestSchema.safeParse({ ...body, targetAnchor: ANCHOR }).success).toBe(true);
    const both = createNoteRequestSchema.safeParse({
      ...body,
      targetAnchor: ANCHOR,
      targetNodeId: REF,
    });
    expect(both.error?.issues.map((i) => [i.path, i.message])).toStrictEqual([
      [['targetAnchor'], NOTE_TARGET_EXCLUSIVE],
    ]);
  });
});
