import type { NoteDocument } from '@bible-artisan/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { textOf } from '@/test/render';
import { NoteContent } from './note-content';

describe('NoteContent (BIB-23, NFR-SEC-002)', () => {
  it('renders the allowlisted structure, with links that open safely in a new tab', () => {
    const doc: NoteDocument = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Conscience' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'hardBreak' },
            {
              type: 'text',
              text: 'source',
              marks: [{ type: 'link', attrs: { href: 'https://example.org/a' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
          ],
        },
      ],
    };
    const { container } = render(<NoteContent doc={doc} label="Note" />);
    const note = screen.getByRole('document', { name: 'Note' });
    expect(within(note).getByRole('heading', { level: 3, name: 'Conscience' })).toBeTruthy();
    const link = within(note).getByRole('link', { name: 'source' });
    expect([
      link.getAttribute('href'),
      link.getAttribute('rel'),
      link.getAttribute('target'),
    ]).toStrictEqual(['https://example.org/a', 'noopener noreferrer nofollow', '_blank']);
    expect(textOf(within(note).getByRole('listitem'))).toContain('item');
    // Text is text: markup in a note is shown, never parsed.
    expect(container.querySelector('script')).toBeNull();
    expect(textOf(note)).toContain('<script>alert(1)</script>');
  });

  it('never renders an unsafe href as a link, even if one reached the client', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    } as NoteDocument;
    render(<NoteContent doc={doc} label="Note" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(textOf(screen.getByRole('document', { name: 'Note' }))).toContain('click');
  });
});

describe('NoteContent reference links (BIB-24)', () => {
  it('renders a verified reference as an internal link to the reader, its label as text', () => {
    const referenceId = 'eeeeeeee-2222-4333-8444-555555555555';
    const studyId = 'aaaaaaaa-2222-4333-8444-555555555555';
    render(
      <NoteContent
        label="Note"
        studyId={studyId}
        doc={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                {
                  type: 'scriptureReference',
                  attrs: { referenceId, label: '<b>Romans 9:1</b>' },
                },
              ],
            },
          ],
        }}
      />,
    );
    const link = screen.getByRole('link', { name: '<b>Romans 9:1</b>' });
    expect({
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      html: link.innerHTML,
    }).toStrictEqual({
      href: `/bible?ref=${referenceId}&study=${studyId}`,
      target: null,
      html: '&lt;b&gt;Romans 9:1&lt;/b&gt;',
    });
  });
});
