import { describe, expect, it } from 'vitest';
import { healthResponseSchema, livenessResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a ready and a not-ready report', () => {
    const ready = { status: 'ok', database: 'up', migrations: 'current' };
    const notReady = { status: 'unavailable', database: 'down', migrations: 'unknown' };
    expect(healthResponseSchema.parse(ready)).toStrictEqual(ready);
    expect(healthResponseSchema.parse(notReady)).toStrictEqual(notReady);
  });

  it('rejects an unknown status and extra fields', () => {
    expect(
      healthResponseSchema.safeParse({ status: 'meh', database: 'up', migrations: 'current' })
        .success,
    ).toBe(false);
    expect(
      healthResponseSchema.strict().safeParse({
        status: 'ok',
        database: 'up',
        migrations: 'current',
        version: '1',
      }).success,
    ).toBe(false);
  });
});

describe('livenessResponseSchema', () => {
  it('accepts only ok', () => {
    expect(livenessResponseSchema.parse({ status: 'ok' })).toStrictEqual({ status: 'ok' });
    expect(livenessResponseSchema.safeParse({ status: 'unavailable' }).success).toBe(false);
  });
});
