import { describe, expect, it } from 'vitest';
import { createGraphViewStore } from './graph-store';

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const at = (list: string[]) => Object.fromEntries(list.map((id, i) => [id, { x: i, y: i }]));

describe('graph view store: the pending-save queue (BIB-28)', () => {
  it('sends an arrangement together with earlier moves when they fit in one request', () => {
    const store = createGraphViewStore();
    store.getState().move(at(ids('m', 30)));
    store.getState().move(at(ids('a', 50)), { together: true });
    expect(store.getState().takePending(100)).toStrictEqual([...ids('m', 30), ...ids('a', 50)]);
    expect(store.getState().pendingIds.size).toBe(0);
  });

  it('sends earlier moves first and the arrangement as its own request when they do not fit', () => {
    const store = createGraphViewStore();
    store.getState().move(at(ids('m', 60)));
    // One arranged node had been moved before: it goes with the arrangement, not before it.
    store.getState().move(at([...ids('a', 49), 'm0']), { together: true });
    const first = store.getState().takePending(100);
    expect(first).toStrictEqual(ids('m', 60).slice(1));
    expect(store.getState().takePending(100)).toStrictEqual([...ids('a', 49), 'm0']);
    expect(store.getState().takePending(100)).toStrictEqual([]);
  });

  it('splits earlier moves over 100 before the arrangement, never the arrangement', () => {
    const store = createGraphViewStore();
    store.getState().move(at(ids('m', 150)));
    store.getState().move(at(ids('a', 100)), { together: true });
    expect(store.getState().takePending(100)).toStrictEqual(ids('m', 150).slice(0, 100));
    expect(store.getState().takePending(100)).toStrictEqual(ids('m', 150).slice(100));
    expect(store.getState().takePending(100)).toStrictEqual(ids('a', 100));
  });
});
