import type { ScriptureAnchor } from '@bible-artisan/contracts';

/**
 * A durable anchor's quote (BIB-18, PRD sections 14 and 30). Resolved: the quote with its
 * reference and edition. Unresolved (the stored text no longer matches): the original quote and
 * edition, said in words rather than by colour alone, with Reselect. It never shows other text in
 * place of the quote. BIB-24 mounts it for saved highlights; the reader shows a fresh capture.
 */
export function AnchorQuote({
  anchor,
  label,
  editionName,
  unresolved = false,
  onReselect,
}: {
  anchor: ScriptureAnchor;
  /** e.g. `Romans 9:1–2`; null when the verses no longer exist. */
  label: string | null;
  /** The edition's name; null when the edition is no longer available. */
  editionName: string | null;
  unresolved?: boolean;
  /** Reopens the passage so the user can select it again; omitted when there is nowhere to go. */
  onReselect?: () => void;
}) {
  const quote =
    anchor.quote === '' ? (
      <span className="font-sans text-base italic text-muted">
        No text for this verse in this edition.
      </span>
    ) : (
      <>“{anchor.quote}”</>
    );
  const source = [label, editionName ? `(${editionName})` : null].filter(Boolean).join(' ');

  if (!unresolved) {
    return (
      <figure className="flex flex-col gap-1">
        <blockquote className="font-serif text-lg">{quote}</blockquote>
        {source ? <figcaption className="text-sm text-muted">{source}</figcaption> : null}
      </figure>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-muted px-3 py-2">
      <p>
        <strong>Unresolved selection.</strong> It no longer matches the text of{' '}
        {editionName ?? 'its original translation'}, so it is not shown on the passage. Original
        quote:
      </p>
      <figure className="flex flex-col gap-1">
        <blockquote className="font-serif text-lg">{quote}</blockquote>
        {source ? <figcaption className="text-sm text-muted">{source}</figcaption> : null}
      </figure>
      {onReselect ? (
        <button
          type="button"
          onClick={onReselect}
          className="self-start rounded border border-accent px-3 py-1 text-accent"
        >
          Reselect
        </button>
      ) : null}
    </div>
  );
}
