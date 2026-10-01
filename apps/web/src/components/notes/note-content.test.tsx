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
