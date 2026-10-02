/**
 * Code-point ranges over stored verse text (BIB-16 search matches, BIB-24 saved highlights): the
 * one place the web splits Scripture into marked runs. Offsets are Unicode code points, never
 * UTF-16 units, and the runs always concatenate back to the text exactly, so the verse element a
 * selection is measured against (BIB-18) still holds the stored text.
 */
export interface CodePointRange<K> {
  /** Inclusive code-point offset. */
  start: number;
  /** Exclusive code-point offset. */
  end: number;
  key: K;
}

export interface CodePointRun<K> {
  text: string;
  /** The ranges covering this run, in the order given (empty: unmarked text). */
  keys: K[];
}

/**
 * Splits `text` at every range boundary. A range that is empty or runs past the text is not
 * drawn at all (never clamped onto other text).
 */
export function codePointRuns<K>(
  text: string,
  ranges: readonly CodePointRange<K>[],
): CodePointRun<K>[] {
  const points = Array.from(text);
  const usable = ranges.filter((r) => r.start >= 0 && r.start < r.end && r.end <= points.length);
  const cuts = [...new Set([0, points.length, ...usable.flatMap((r) => [r.start, r.end])])].sort(
    (a, b) => a - b,
  );
  const runs: CodePointRun<K>[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const from = cuts[i] ?? 0;
    const to = cuts[i + 1] ?? from;
    if (to <= from) continue;
    runs.push({
      text: points.slice(from, to).join(''),
      keys: usable.filter((r) => r.start <= from && r.end >= to).map((r) => r.key),
    });
  }
  return runs;
}
