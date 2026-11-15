import { describe, expect, it } from 'vitest';
import { limitState, studyLimitsResponseSchema } from './limits';

describe('limitState', () => {
  it('is ok below 80%, warning from 80% and reached at the cap', () => {
    expect([0, 1599, 1600, 1999, 2000, 2001].map((used) => limitState(used, 2000))).toStrictEqual([
      'ok',
      'ok',
      'warning',
      'warning',
      'reached',
      'reached',
    ]);
  });
});

describe('studyLimitsResponseSchema', () => {
  it('rejects a usage without its state', () => {
    const usage = { used: 1, limit: 2, state: 'ok' };
    expect(
      studyLimitsResponseSchema.safeParse({
        nodes: usage,
        edges: usage,
        events: usage,
        storage: { used: 1, limit: 2 },
      }).success,
    ).toBe(false);
  });
});
