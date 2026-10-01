import {
  httpUrlSchema,
  type NoteBlock,
  type NoteDocument,
  type NoteInline,
  type NoteMark,
} from '@bible-artisan/contracts';
import type { ReactNode } from 'react';

/**
 * Link attributes for user-supplied URLs (PRD section 29: "external links accept HTTPS/HTTP only,
 * open with safe rel attributes"): a new tab that cannot reach back into the app (`noopener`),
 * sends no referrer (`noreferrer`) and passes no ranking (`nofollow`). The editor uses the same.
 */
export const NOTE_LINK_REL = 'noopener noreferrer nofollow';
export const NOTE_LINK_TARGET = '_blank';

/** Only an http(s) URL the shared schema accepts becomes a link; anything else stays text. */
const safeHref = (href: string): string | null => {
  const parsed = httpUrlSchema.safeParse(href);
  return parsed.success ? parsed.data : null;
};

function withMarks(text: string, marks: readonly NoteMark[] | undefined): ReactNode {
  let node: ReactNode = text;
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') node = <strong>{node}</strong>;
    else if (mark.type === 'italic') node = <em>{node}</em>;
    else {
      const href = safeHref(mark.attrs.href);
      if (href !== null) {
        node = (
          <a
            href={href}
            rel={NOTE_LINK_REL}
            target={NOTE_LINK_TARGET}
            className="text-accent underline"
          >
            {node}
          </a>
        );
      }
    }
  }
  return node;
}

function inline(content: readonly NoteInline[] | undefined): ReactNode[] {
  return (content ?? []).map((node, index) =>
    node.type === 'hardBreak' ? (
      <br key={index} />
    ) : (
      <span key={index}>{withMarks(node.text, node.marks)}</span>
    ),
  );
}

function block(node: NoteBlock, key: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{inline(node.content)}</p>;
    case 'heading': {
      const Heading = (['h3', 'h4', 'h5'] as const)[node.attrs.level - 1] ?? 'h5';
      return (
        <Heading key={key} className="font-serif font-semibold">
          {inline(node.content)}
        </Heading>
      );
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-4 border-muted pl-3">
          {node.content.map(block)}
        </blockquote>
      );
    case 'bulletList':
      return (
        <ul key={key} className="list-disc pl-6">
          {node.content.map((item, index) => (
            <li key={index}>{item.content.map(block)}</li>
          ))}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} start={node.attrs?.start} className="list-decimal pl-6">
          {node.content.map((item, index) => (
            <li key={index}>{item.content.map(block)}</li>
          ))}
        </ol>
      );
  }
}

/**
 * A note document rendered read-only (BIB-23): a version preview, a note in the trash or in an
 * archived study. It builds React elements from the validated JSON (never
 * `dangerouslySetInnerHTML`), so stored content can only ever produce the allowlisted elements
 * above, and every text node is escaped by React. Note headings sit below the page's own heading
 * levels (h3-h5).
 */
export function NoteContent({ doc, label }: { doc: NoteDocument; label: string }) {
  return (
    <div aria-label={label} role="document" className="flex flex-col gap-2 break-words">
      {doc.content.map(block)}
    </div>
  );
}
