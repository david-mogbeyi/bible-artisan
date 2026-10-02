import type { ScriptureAnchor } from '@bible-artisan/contracts';

/**
 * A durable anchor's quote (BIB-18, PRD sections 14 and 30): the quote exactly as the server
 * checked it, with its reference and edition. BIB-24 also uses it for a stored anchor that no
 * longer matches the text (its original quote, beside the reason and Reselect).
 */
export function AnchorQuote({
  anchor,
  label,
  editionName,
}: {
  anchor: ScriptureAnchor;
  /** e.g. `Romans 9:1–2`. */
  label: string;
  editionName: string;
}) {
  return (
    <figure className="flex flex-col gap-1">
      <blockquote className="font-serif text-lg">
        {anchor.quote === '' ? (
          <span className="font-sans text-base italic text-muted">
            No text for this verse in this edition.
          </span>
        ) : (
          <>“{anchor.quote}”</>
        )}
      </blockquote>
      <figcaption className="text-sm text-muted">
        {label} ({editionName})
      </figcaption>
    </figure>
  );
}
