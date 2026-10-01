import type { ScriptureAnchor } from '@bible-artisan/contracts';

/**
 * A durable anchor's quote (BIB-18, PRD sections 14 and 30): the quote exactly as the server
 * checked it, with its reference and edition. The unresolved state (original quote, said in
 * words, with Reselect) ships with BIB-24, which stores anchors and re-checks them.
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
