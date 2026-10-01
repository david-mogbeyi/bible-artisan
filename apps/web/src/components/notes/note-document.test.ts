import { describe, expect, it } from 'vitest';
import {
  classifyNoteFieldErrors,
  cleanNoteText,
  toNoteDocument,
  toNoteDraft,
} from './note-document';

describe('toNoteDocument (BIB-23)', () => {
  it("drops Tiptap's own attributes the allowlist does not carry and keeps the content", () => {
    // The shape Tiptap 3's getJSON() produces for a link and an ordered list.
    const editorJson = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.org',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    class: null,
                    title: null,
                  },
                },
              ],
              text: 'site',
            },
          ],
        },
        { type: 'paragraph', content: [] },
      ],
    };
    expect(toNoteDocument(editorJson)).toStrictEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'site',
              marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
            },
          ],
        },
        { type: 'paragraph' },
      ],
    });
  });

  it('refuses what the allowlist refuses instead of rewriting it', () => {
    expect(
      toNoteDocument({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] }),
    ).toBeNull();
    expect(
      toNoteDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      }),
    ).toBeNull();
    expect(toNoteDocument(null)).toBeNull();
  });
  const list = (attrs: Record<string, unknown>) => ({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { ...attrs, type: null },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
          },
        ],
      },
    ],
  });
  const savedStart = (attrs: Record<string, unknown>) => {
    const saved = toNoteDocument(list(attrs));
    const block = saved?.content[0];
    return block?.type === 'orderedList' ? (block.attrs?.start ?? 'default') : 'refused';
  };

  it("brings an ordered list's start into the range the server takes instead of refusing the note", () => {
    // "0. " makes start 0, "123456. " a huge start, Tiptap's default is 1.
    expect(
      [0, -3, 1, 2.5, 7, 10_000, 123_456, null].map((start) => savedStart({ start })),
    ).toStrictEqual(['default', 'default', 'default', 'default', 7, 10_000, 10_000, 'default']);
  });

  it('turns control characters in text into spaces, keeps tabs and emoji, and drops runs that held only them', () => {
    expect(cleanNoteText('a\vb\fc\u0000d\re\tf🙂')).toBe('a b c d e\tf🙂');
    expect(cleanNoteText('lone \uD800 surrogate')).toBe('lone \uFFFD surrogate');
    expect(
      toNoteDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'page\fbreak' },
              { type: 'text', text: 'x', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      }),
    ).toStrictEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'page break' },
            { type: 'text', text: 'x', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
  });

  it('says which kind of content cannot be saved', () => {
    const linked = (href: string) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
        },
      ],
    });
    let deep: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < 12; i += 1) deep = { type: 'blockquote', content: [deep] };
    expect([
      toNoteDraft(linked('javascript:alert(1)')),
      toNoteDraft({ type: 'doc', content: [deep] }),
      toNoteDraft({ type: 'doc', content: [{ type: 'image' }] }),
    ]).toStrictEqual([
      { ok: false, problem: 'link' },
      { ok: false, problem: 'too_deep' },
      { ok: false, problem: 'structure' },
    ]);
    expect(
      [
        { 'content.content.0.attrs.start': ['Too big'] },
        { 'content.content.0.content.0.text': ['Remove control or invalid characters'] },
        { content: ['A note can nest at most 12 levels'] },
        { content: ['A note can have at most 20,000 elements'] },
        undefined,
      ].map(classifyNoteFieldErrors),
    ).toStrictEqual(['list_numbering', 'characters', 'too_deep', 'too_many_parts', 'structure']);
  });
});
