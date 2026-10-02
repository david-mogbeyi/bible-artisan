'use client';

import type { NoteResponse, NoteSummary } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { fetchTranslations, bibleHref, TRANSLATIONS_QUERY_KEY } from '@/lib/bible';
import { AnchorQuote } from '@/components/bible/anchor-quote';
import { anchorProblemText } from '@/components/bible/study-highlights';

/** What a note is attached to, in one line (references only, never a quote). */
export function noteTargetText(note: Pick<NoteSummary, 'target'>): string {
  const { target } = note;
  if (!target) return 'On this study';
  if (target.kind === 'scripture') {
    const label = target.reference?.label ?? 'a passage';
    const where = target.anchorKind === 'phrase' ? `On a phrase in ${label}` : `On ${label}`;
    return target.problem ? `${where} (no longer matches the text)` : where;
  }
  return target.nodeType === 'question' ? `On the question: ${target.label}` : `On ${target.label}`;
}

/**
 * An open note's Scripture target (BIB-24): the passage it is attached to, with the exact words
 * when it is a phrase. When the stored anchor no longer matches the text it is said so, with the
 * original quote and Reselect; it is never moved to nearby text.
 */
export function NoteScriptureTarget({ note, studyId }: { note: NoteResponse; studyId: string }) {
  const { target, targetAnchor } = note;
  // The edition's name, asked for only when there is a passage to caption.
  const translations = useQuery({
    queryKey: TRANSLATIONS_QUERY_KEY,
    queryFn: fetchTranslations,
    enabled: target?.kind === 'scripture',
  });
  if (target?.kind !== 'scripture' || !targetAnchor) return null;
  const editionName =
    translations.data?.translations.find((t) => t.id === targetAnchor.editionId)?.name ??
    'its translation';
  const label = target.reference?.label ?? 'Passage';
  return (
    <section
      aria-label="Attached passage"
      className={`flex flex-col gap-2 rounded border px-3 py-2 ${
        target.problem ? 'border-accent' : 'border-muted'
      }`}
    >
      {target.problem ? (
        <p>
          This note’s passage no longer matches the {editionName} text.{' '}
          {anchorProblemText(target.problem)} The words it was attached to:
        </p>
      ) : (
        <p>{noteTargetText(note)}</p>
      )}
      <AnchorQuote anchor={targetAnchor} label={label} editionName={editionName} />
      {target.reference ? (
        <Link
          href={bibleHref(target.reference.id, studyId)}
          className="self-start text-accent underline"
        >
          {target.problem ? 'Reselect' : 'Read'}{' '}
          <span className="sr-only">{target.reference.label}</span>
        </Link>
      ) : null}
    </section>
  );
}
