import { describe, expect, it } from 'vitest';
import { isStateChangingMethod } from './http-request';

describe('isStateChangingMethod', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'Options'])('treats %s as safe', (method) => {
    expect(isStateChangingMethod(method)).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'LINK', 'post'])(
    'treats %s as state-changing',
    (method) => {
      expect(isStateChangingMethod(method)).toBe(true);
    },
  );
});
