import { describe, expect, it } from 'vitest';
import { healthResponseSchema, livenessResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a ready and a not-ready report', () => {
    const ready = { status: 'ok', database: 'up', migrations: 'current', corpus: 'ready' };
    const notReady = {
      status: 'unavailable',
      database: 'down',
      migrations: 'unknown',
      corpus: 'unknown',
    };
    const noCorpus = {
      status: 'unavailable',
      database: 'up',
      migrations: 'current',
      corpus: 'missing',
    };
    const corruptCorpus = { ...noCorpus, corpus: 'corrupt' };
    expect(healthResponseSchema.parse(ready)).toStrictEqual(ready);
    expect(healthResponseSchema.parse(notReady)).toStrictEqual(notReady);
    expect(healthResponseSchema.parse(noCorpus)).toStrictEqual(noCorpus);
    expect(healthResponseSchema.parse(corruptCorpus)).toStrictEqual(corruptCorpus);
  });

  it('rejects an unknown status and extra fields', () => {
    expect(
      healthResponseSchema.safeParse({
        status: 'meh',
        database: 'up',
        migrations: 'current',
        corpus: 'ready',
      }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ status: 'ok', database: 'up', migrations: 'current' })
        .success,
    ).toBe(false);
    expect(
      healthResponseSchema.strict().safeParse({
        status: 'ok',
        database: 'up',
        migrations: 'current',
        corpus: 'ready',
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
