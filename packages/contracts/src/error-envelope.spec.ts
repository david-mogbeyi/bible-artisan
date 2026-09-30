import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from './error-envelope';

describe('errorEnvelopeSchema', () => {
  it('accepts the minimal required shape', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'Not found',
      retryable: false,
      correlationId: 'corr-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts fieldErrors and currentRevision when present', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'REVISION_CONFLICT',
      message: 'Stale revision',
      fieldErrors: { title: ['too long'] },
      retryable: true,
      correlationId: 'corr-2',
      currentRevision: 7,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing correlationId', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'VALIDATION',
      message: 'Bad input',
      retryable: false,
    });
    expect(result.success).toBe(false);
  });
});
