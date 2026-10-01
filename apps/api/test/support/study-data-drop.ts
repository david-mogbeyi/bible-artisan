import { withCorpusDropAllowed } from './corpus-drop';

/**
 * Runs `work` with ALLOW_STUDY_DATA_DROP=1 (the opt-in the study and user migrations' `down`
 * require while study or user data exists; ADR 0001, BIB-19 addendum), restoring the previous
 * value afterwards.
 */
export async function withStudyDataDropAllowed<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.ALLOW_STUDY_DATA_DROP;
  process.env.ALLOW_STUDY_DATA_DROP = '1';
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.ALLOW_STUDY_DATA_DROP;
    else process.env.ALLOW_STUDY_DATA_DROP = previous;
  }
}

/** Both destructive-`down` opt-ins: the corpus one and the study-data one. */
export function withAllDropsAllowed<T>(work: () => Promise<T>): Promise<T> {
  return withStudyDataDropAllowed(() => withCorpusDropAllowed(work));
}
