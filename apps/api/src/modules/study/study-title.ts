import { MAX_STUDY_TITLE_LENGTH, UNTITLED_STUDY_TITLE } from '@bible-artisan/contracts';

export interface StudyTitleSources {
  /** The title the user typed (already trimmed and length-checked by the contract). */
  title?: string | undefined;
  /** The starting reference's display label, e.g. `Romans 9:1`. */
  referenceLabel?: string | undefined;
  /** The question the user typed (already trimmed). */
  question?: string | undefined;
}

/**
 * The title a new study starts with (PRD section 10: derived deterministically from the starting
 * reference until the user edits it): the typed title, else the reference label, else the
 * question cut to the title limit, else `Untitled study` for a blank study.
 */
export function deriveStudyTitle({ title, referenceLabel, question }: StudyTitleSources): string {
  if (title !== undefined) return title;
  if (referenceLabel !== undefined) return referenceLabel;
  if (question !== undefined) return truncateTitle(question);
  return UNTITLED_STUDY_TITLE;
}

/**
 * Cuts text to the title limit as the contract measures it (UTF-16 length), never inside a
 * surrogate pair, and drops whitespace left at the cut.
 */
function truncateTitle(text: string): string {
  if (text.length <= MAX_STUDY_TITLE_LENGTH) return text;
  let cut = '';
  for (const codePoint of text) {
    if (cut.length + codePoint.length > MAX_STUDY_TITLE_LENGTH) break;
    cut += codePoint;
  }
  return cut.trimEnd();
}
