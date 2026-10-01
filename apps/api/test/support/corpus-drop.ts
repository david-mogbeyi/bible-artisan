/**
 * Runs `work` with ALLOW_CORPUS_DROP=1 (the opt-in the corpus migration's `down` requires while an
 * edition is active; ADR 0001, BIB-14 addendum), restoring the previous value afterwards.
 */
export async function withCorpusDropAllowed<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.ALLOW_CORPUS_DROP;
  process.env.ALLOW_CORPUS_DROP = '1';
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.ALLOW_CORPUS_DROP;
    else process.env.ALLOW_CORPUS_DROP = previous;
  }
}
