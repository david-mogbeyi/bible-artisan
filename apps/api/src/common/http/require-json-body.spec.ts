import { describe, expect, it } from 'vitest';
import { isNonJsonMutation } from './require-json-body';

const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers });

describe('isNonJsonMutation', () => {
  it.each([
    ['a JSON POST', req('POST', { 'content-type': 'application/json', 'content-length': '2' })],
    ['JSON with a charset', req('PATCH', { 'content-type': 'Application/JSON; charset=utf-8' })],
    ['a bodyless POST without a Content-Type', req('POST')],
    ['a POST with an explicitly empty body', req('POST', { 'content-length': '0' })],
    ['a GET with any Content-Type', req('GET', { 'content-type': 'text/plain' })],
    [
      'an OPTIONS preflight with any Content-Type',
      req('OPTIONS', { 'content-type': 'text/plain' }),
    ],
    ['a bodyless non-standard method', req('PROPFIND')],
  ])('allows %s', (_label, request) => {
    expect(isNonJsonMutation(request)).toBe(false);
  });

  it.each([
    ['a form POST', req('POST', { 'content-type': 'application/x-www-form-urlencoded' })],
    ['a text/plain PUT', req('PUT', { 'content-type': 'text/plain', 'content-length': '5' })],
    ['a multipart DELETE', req('DELETE', { 'content-type': 'multipart/form-data; boundary=x' })],
    ['a JSON look-alike type', req('POST', { 'content-type': 'application/jsonx' })],
    ['a body without a Content-Type', req('POST', { 'content-length': '12' })],
    ['a chunked body without a Content-Type', req('POST', { 'transfer-encoding': 'chunked' })],
    // Same method set as the Origin check: anything but GET/HEAD/OPTIONS is a mutation.
    ['a text/plain PROPFIND', req('PROPFIND', { 'content-type': 'text/plain' })],
    ['a form-encoded LINK', req('LINK', { 'content-type': 'application/x-www-form-urlencoded' })],
  ])('refuses %s', (_label, request) => {
    expect(isNonJsonMutation(request)).toBe(true);
  });
});
