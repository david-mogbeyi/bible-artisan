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
  ])('refuses %s', (_label, request) => {
    expect(isNonJsonMutation(request)).toBe(true);
  });
});
