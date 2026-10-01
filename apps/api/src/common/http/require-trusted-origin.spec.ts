import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { isUntrustedMutation, requireTrustedOrigin } from './require-trusted-origin';

const ALLOWED = new Set(['http://localhost:3000', 'https://app.example.test']);

function req(method: string, headers: Record<string, string | string[] | undefined> = {}) {
  return { method, headers };
}

describe('isUntrustedMutation', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])(
    '%s from an allowed Origin is trusted',
    (method) => {
      expect(
        isUntrustedMutation(req(method, { origin: 'https://app.example.test' }), ALLOWED),
      ).toBe(false);
    },
  );

  it.each(['PUT', 'PATCH', 'DELETE', 'PROPFIND', 'LINK', 'post'])(
    'checks %s (anything but GET/HEAD/OPTIONS fails closed)',
    (method) => {
      expect(isUntrustedMutation(req(method, { origin: 'https://evil.test' }), ALLOWED)).toBe(true);
    },
  );

  it.each([
    'https://evil.test',
    'null',
    'https://app.example.test.evil.test',
    'https://APP.example.test',
    'https://app.example.test/',
    'http://app.example.test',
    '',
  ])('refuses a mutation from Origin %j', (origin) => {
    expect(isUntrustedMutation(req('POST', { origin }), ALLOWED)).toBe(true);
  });

  it('refuses a repeated Origin header', () => {
    expect(
      isUntrustedMutation(req('POST', { origin: ['https://app.example.test'] }), ALLOWED),
    ).toBe(true);
  });

  it('refuses a mutation with no Origin but Sec-Fetch-Site: cross-site', () => {
    expect(isUntrustedMutation(req('DELETE', { 'sec-fetch-site': 'cross-site' }), ALLOWED)).toBe(
      true,
    );
  });

  it.each(['same-origin', 'same-site', 'none'])(
    'allows a mutation with no Origin and Sec-Fetch-Site: %s',
    (site) => {
      expect(isUntrustedMutation(req('POST', { 'sec-fetch-site': site }), ALLOWED)).toBe(false);
    },
  );

  it('allows a non-browser mutation that sends neither header', () => {
    expect(isUntrustedMutation(req('POST'), ALLOWED)).toBe(false);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never refuses %s', (method) => {
    expect(
      isUntrustedMutation(
        req(method, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }),
        ALLOWED,
      ),
    ).toBe(false);
  });
});

describe('requireTrustedOrigin', () => {
  it('passes a ForbiddenException to next for an untrusted mutation, else calls next()', () => {
    const middleware = requireTrustedOrigin([...ALLOWED]);
    const next = vi.fn();
    middleware(req('POST', { origin: 'https://evil.test' }), undefined, next);
    expect(next).toHaveBeenLastCalledWith(expect.any(ForbiddenException));
    middleware(req('POST', { origin: 'http://localhost:3000' }), undefined, next);
    expect(next).toHaveBeenLastCalledWith(undefined);
  });
});
