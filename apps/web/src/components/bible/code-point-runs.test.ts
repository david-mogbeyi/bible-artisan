import { describe, expect, it } from 'vitest';
import { codePointRuns } from './code-point-runs';

describe('codePointRuns (BIB-16/24)', () => {
  it('splits by code point at every boundary and joins back to the text exactly', () => {
    const text = 'a🙂bc d';
    const runs = codePointRuns(text, [
      { start: 1, end: 3, key: 'x' },
      { start: 2, end: 5, key: 'y' },
    ]);
    expect(runs).toStrictEqual([
      { text: 'a', keys: [] },
      { text: '🙂', keys: ['x'] },
      { text: 'b', keys: ['x', 'y'] },
      { text: 'c ', keys: ['y'] },
      { text: 'd', keys: [] },
    ]);
    expect(runs.map((r) => r.text).join('')).toBe(text);
  });

  it('never draws an empty range or one that runs past the text', () => {
    expect(
      codePointRuns('abc', [
        { start: 1, end: 1, key: 'empty' },
        { start: 2, end: 9, key: 'past' },
      ]),
    ).toStrictEqual([{ text: 'abc', keys: [] }]);
  });
});
