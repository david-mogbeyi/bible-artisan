import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('rejects an unknown status', () => {
    const result = healthResponseSchema.safeParse({ status: 'meh', database: 'up', version: '1' });
    expect(result.success).toBe(false);
  });
});
