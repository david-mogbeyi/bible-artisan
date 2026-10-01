import { describe, expect, it } from 'vitest';
import { toNoteDocument } from './note-document';

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
});
