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
  const STUDY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const matched = {
    method: 'post',
    baseUrl: '',
    route: { path: '/v1/studies/:studyId' },
    headers: { 'idempotency-key': KEY },
    body: { a: 1 },
  };

  it('takes method, the matched route pattern, lower-cased UUID params, body, and the key', () => {
    expect(
      mutationRequestInfo({ ...matched, params: { studyId: STUDY.toUpperCase(), slug: 'Ab' } }),
    ).toStrictEqual({
      idempotencyKey: KEY,
      method: 'POST',
      route: '/v1/studies/:studyId',
      params: { studyId: STUDY, slug: 'Ab' },
      body: { a: 1 },
    });
  });

  it('prefixes a router mount path', () => {
    expect(
      mutationRequestInfo({ ...matched, baseUrl: '/v1', route: { path: '/x' }, params: {} }).route,
    ).toBe('/v1/x');
  });

  it('refuses a request that was not matched to a route', () => {
    expect(() => mutationRequestInfo({ ...matched, route: undefined })).toThrow(
      'needs a request matched to a route',
    );
  });
});
