import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  MAX_SELECTION_HISTORY,
  pushSelection,
  type SelectionHistory,
  stepBack,
  stepForward,
} from './selection-history';

const push = (...ids: string[]) => ids.reduce<SelectionHistory>(pushSelection, EMPTY_HISTORY);
const all = new Set(['a', 'b', 'c', 'd']);

describe('selection history (BIB-29)', () => {
  it('adds each newly selected node as the current entry, but not the current node again', () => {
    expect(push('a', 'b')).toStrictEqual({ ids: ['a', 'b'], index: 1 });
    const history = push('a', 'b');
    expect(pushSelection(history, 'b')).toBe(history);
  });

  it('steps back and forward without adding entries, and reports each end', () => {
    const start = push('a', 'b', 'c');
    const back = stepBack(start, all);
    expect(back).toStrictEqual({ history: { ids: ['a', 'b', 'c'], index: 1 }, id: 'b' });
    const first = stepBack(back.history, all);
    expect(first.id).toBe('a');
    expect(stepBack(first.history, all).id).toBeNull();
    const forward = stepForward(first.history, all);
    expect(forward).toStrictEqual({ history: { ids: ['a', 'b', 'c'], index: 1 }, id: 'b' });
    expect(stepForward(start, all).id).toBeNull();
    expect(stepBack(EMPTY_HISTORY, all).id).toBeNull();
  });

  it('drops the forward entries when a node is selected after Back', () => {
    const back = stepBack(push('a', 'b', 'c'), all).history;
    expect(pushSelection(back, 'd')).toStrictEqual({ ids: ['a', 'b', 'd'], index: 2 });
  });

  it(`keeps the latest ${MAX_SELECTION_HISTORY} entries`, () => {
    const ids = Array.from({ length: MAX_SELECTION_HISTORY + 5 }, (_, i) => `n${i}`);
    const history = push(...ids);
    expect(history.ids).toStrictEqual(ids.slice(5));
    expect(history.index).toBe(MAX_SELECTION_HISTORY - 1);
  });

  it('skips and removes entries for nodes no longer in the snapshot, in both directions', () => {
    const live = new Set(['a', 'c']);
    const back = stepBack(push('a', 'b', 'c'), live);
    expect(back).toStrictEqual({ history: { ids: ['a', 'c'], index: 0 }, id: 'a' });
    const forward = stepForward({ ids: ['a', 'b', 'c'], index: 0 }, live);
    expect(forward).toStrictEqual({ history: { ids: ['a', 'c'], index: 1 }, id: 'c' });
    // Nothing live left that way: the end, with the stale entries gone.
    expect(stepBack({ ids: ['b', 'c'], index: 1 }, live)).toStrictEqual({
      history: { ids: ['c'], index: 0 },
      id: null,
    });
  });

  it('skips an entry that would reselect the current node (a removed one sat between them)', () => {
    const live = new Set(['a', 'c']);
    expect(stepBack({ ids: ['c', 'a', 'b', 'a'], index: 3 }, live)).toStrictEqual({
      history: { ids: ['c', 'a'], index: 0 },
      id: 'c',
    });
  });
});
