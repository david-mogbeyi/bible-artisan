import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors/domain-errors';
import { mutationRequestInfo, parseIdempotencyKey } from './mutation-request';

const KEY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('parseIdempotencyKey', () => {
  it('returns null when the header is absent', () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });

  it('lower-cases a UUID', () => {
    expect(parseIdempotencyKey(KEY.toUpperCase())).toBe(KEY);
  });

  it.each([[''], ['retry-1'], [`${KEY}, ${KEY}`], [[KEY, KEY]]])(
    'rejects %j with a fixed field error',
    (header) => {
      let thrown: unknown;
      try {
        parseIdempotencyKey(header);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError).fieldErrors).toStrictEqual({
        'Idempotency-Key': ['Must be a UUID'],
      });
    },
  );
});

describe('mutationRequestInfo', () => {
  it('takes method, path without query, body, and the key', () => {
    expect(
      mutationRequestInfo({
        method: 'post',
        originalUrl: '/v1/studies?x=1',
        headers: { 'idempotency-key': KEY },
        body: { a: 1 },
      }),
    ).toStrictEqual({ idempotencyKey: KEY, method: 'POST', path: '/v1/studies', body: { a: 1 } });
  });
});
