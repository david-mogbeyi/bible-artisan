import {
  httpUrlSchema,
  type NoteBlock,
  type NoteDocument,
  type NoteInline,
  type NoteMark,
} from '@bible-artisan/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { bibleHref } from '@/lib/bible';
import { studyNodeHref } from '@/lib/nodes';

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

/**
 * `studyId`: the study whose reader a verified reference link opens and whose nodes a mention
 * opens (null: the reader outside a study). `deletedNodeIds`: mentioned nodes deleted since.
 */
interface Context {
  studyId: string | null;
  deletedNodeIds: ReadonlySet<string>;
}

/** What a mention of a deleted node reads as (BIB-58): its label and that it was deleted. */
export const DELETED_MENTION_SUFFIX = ' (deleted node)';

function inline(content: readonly NoteInline[] | undefined, context: Context): ReactNode[] {
  const { studyId } = context;
  return (content ?? []).map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />;
    if (node.type === 'nodeMention') {
      // A node of this study (BIB-58): its opaque id in the link, its label as text. A deleted
      // node says so and is not linked (never re-pointed).
      const { nodeId, label } = node.attrs;
      if (studyId === null || context.deletedNodeIds.has(nodeId)) {
        return (
          <span key={index}>
            {label}
            {context.deletedNodeIds.has(nodeId) ? DELETED_MENTION_SUFFIX : ''}
          </span>
        );
      }
      return (
        <Link key={index} href={studyNodeHref(studyId, nodeId)} className="text-accent underline">
          {label}
        </Link>
      );
    }
    if (node.type === 'scriptureReference') {
      // A verified internal link (BIB-24): an opaque reference id, its canonical label as text.
      return (
        <Link
          key={index}
          href={bibleHref(node.attrs.referenceId, studyId)}
          className="text-accent underline"
        >
          {node.attrs.label}
        </Link>
      );
    }
    return <span key={index}>{withMarks(node.text, node.marks)}</span>;
  });
}

function block(node: NoteBlock, key: number, context: Context): ReactNode {
  const blocks = (children: readonly NoteBlock[]) =>
    children.map((child, index) => block(child, index, context));
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{inline(node.content, context)}</p>;
    case 'heading': {
      const Heading = (['h3', 'h4', 'h5'] as const)[node.attrs.level - 1] ?? 'h5';
      return (
        <Heading key={key} className="font-serif font-semibold">
          {inline(node.content, context)}
        </Heading>
      );
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-4 border-muted pl-3">
          {blocks(node.content)}
        </blockquote>
      );
    case 'bulletList':
      return (
        <ul key={key} className="list-disc pl-6">
          {node.content.map((item, index) => (
            <li key={index}>{blocks(item.content)}</li>
          ))}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} start={node.attrs?.start} className="list-decimal pl-6">
          {node.content.map((item, index) => (
            <li key={index}>{blocks(item.content)}</li>
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
export function NoteContent({
  doc,
  label,
  studyId = null,
  deletedNodeIds = [],
}: {
  doc: NoteDocument;
  label: string;
  /** Reference links open the reader in this study (BIB-24); mentions open its nodes (BIB-58). */
  studyId?: string | null;
  /** Mentioned nodes that were deleted (BIB-58), from the note's `deletedMentionNodeIds`. */
  deletedNodeIds?: readonly string[];
}) {
  const context: Context = { studyId, deletedNodeIds: new Set(deletedNodeIds) };
  return (
    <div aria-label={label} role="document" className="flex flex-col gap-2 break-words">
      {doc.content.map((node, index) => block(node, index, context))}
    </div>
  );
}
