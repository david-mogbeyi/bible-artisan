import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from './errors';

describe('errorEnvelopeSchema', () => {
  it('accepts the minimum required shape', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'Not found',
      retryable: false,
      correlationId: 'corr-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts currentRevision and fieldErrors when present', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'REVISION_CONFLICT',
      message: 'Stale revision',
      fieldErrors: { title: ['too long'] },
      retryable: true,
      correlationId: 'corr-2',
      currentRevision: 4,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'Not found',
      correlationId: 'corr-3',
    });
    expect(result.success).toBe(false);
  });
});
