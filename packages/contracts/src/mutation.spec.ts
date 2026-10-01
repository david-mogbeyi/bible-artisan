import { describe, expect, it } from 'vitest';
import { eventSequenceSchema, expectedRevisionSchema, idempotencyKeySchema } from './mutation';

describe('expectedRevisionSchema', () => {
  it.each([1, 7, 2_147_483_647])('accepts %s', (value) => {
    expect(expectedRevisionSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 1.5, 2_147_483_648, '1', null])('rejects %s', (value) => {
    expect(expectedRevisionSchema.safeParse(value).success).toBe(false);
  });
});

describe('idempotencyKeySchema', () => {
  it('accepts a UUID in either case', () => {
    expect(idempotencyKeySchema.safeParse('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b').success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse('3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B').success).toBe(
      true,
    );
  });

  it.each([
    '',
    'retry-1',
    '3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b',
    '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5',
  ])('rejects %j', (value) => {
    expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
  });
});

describe('eventSequenceSchema', () => {
  it('accepts positive decimal strings beyond 2^53', () => {
    expect(eventSequenceSchema.safeParse('9007199254740993').success).toBe(true);
  });

  it.each(['0', '01', '-1', '1.0', 1])('rejects %j', (value) => {
    expect(eventSequenceSchema.safeParse(value).success).toBe(false);
  });
});
