/**
 * Back / Forward through recently selected nodes (BIB-29, PRD section 12: "local back/forward
 * selection history", separate from content undo). Pure functions over opaque node ids; the
 * graph view store holds the one history of a study page, for the page session only.
 */
export interface SelectionHistory {
  ids: readonly string[];
  /** The current entry: -1 while the history is empty. */
  index: number;
}

/** The PRD's undo depth, reused for navigation (not specified for it). */
export const MAX_SELECTION_HISTORY = 50;

export const EMPTY_HISTORY: SelectionHistory = { ids: [], index: -1 };

/**
 * The selection became exactly `id`: a new current entry, unless it already is the current one.
 * Entries after the current one (where Back had gone from) are dropped; the oldest go past the cap.
 */
export function pushSelection(history: SelectionHistory, id: string): SelectionHistory {
  if (history.ids[history.index] === id) return history;
  const ids = [...history.ids.slice(0, history.index + 1), id].slice(-MAX_SELECTION_HISTORY);
  return { ids, index: ids.length - 1 };
}

export interface Step {
  history: SelectionHistory;
  /** The node to select, or null at that end of the history (nothing to step to). */
  id: string | null;
}

/**
 * One step back (`-1`) or forward (`+1`). Entries no longer in the snapshot (`live`), and entries
 * repeating the current node, are skipped and removed on the way, so a step always lands on a
 * live, different node or reports the end.
 */
function step(history: SelectionHistory, delta: -1 | 1, live: ReadonlySet<string>): Step {
  const ids = [...history.ids];
  let index = history.index;
  let target = index + delta;
  while (target >= 0 && target < ids.length) {
    const id = ids[target] as string;
    if (live.has(id) && id !== ids[index]) {
      return { history: { ids, index: target }, id };
    }
    ids.splice(target, 1);
    if (delta === -1) {
      // An entry before the current one went: everything from it on shifted down by one.
      index -= 1;
      target -= 1;
    }
  }
  return { history: { ids, index }, id: null };
}

export function stepBack(history: SelectionHistory, live: ReadonlySet<string>): Step {
  return step(history, -1, live);
}

export function stepForward(history: SelectionHistory, live: ReadonlySet<string>): Step {
  return step(history, 1, live);
}
