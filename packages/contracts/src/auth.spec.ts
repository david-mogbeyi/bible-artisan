import { describe, expect, it } from 'vitest';
import { otpStartRequestSchema, otpVerifyRequestSchema } from './auth';

describe('otpStartRequestSchema', () => {
  it('trims and lower-cases the email', () => {
    expect(otpStartRequestSchema.parse({ email: '  Reader@Example.TEST ' })).toStrictEqual({
      email: 'reader@example.test',
    });
  });

  it.each([['not-an-email'], [''], [`${'a'.repeat(250)}@example.test`]])('rejects %j', (email) => {
    expect(otpStartRequestSchema.safeParse({ email }).success).toBe(false);
  });
});

describe('otpVerifyRequestSchema', () => {
  const challengeId = '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42';

  it('accepts a 6-digit code (trimmed)', () => {
    expect(otpVerifyRequestSchema.parse({ challengeId, code: ' 012345 ' })).toStrictEqual({
      challengeId,
      code: '012345',
    });
  });

  it.each([['12345'], ['1234567'], ['12a456']])('rejects code %j', (code) => {
    expect(otpVerifyRequestSchema.safeParse({ challengeId, code }).success).toBe(false);
  });
});
