import { describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint } from './fingerprint';

describe('canonicalJson', () => {
  it('sorts object keys recursively, including inside arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('drops undefined members like JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serializes scalars as JSON', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('requestFingerprint', () => {
  const base = { method: 'POST', path: '/v1/studies', body: { title: 'A', expectedRevision: 1 } };

  it('is a 64-character hex SHA-256', () => {
    expect(requestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores body key order and method case', () => {
    expect(
      requestFingerprint({
        method: 'post',
        path: '/v1/studies',
        body: { expectedRevision: 1, title: 'A' },
      }),
    ).toBe(requestFingerprint(base));
  });

  it.each([
    ['method', { ...base, method: 'PATCH' }],
    ['path', { ...base, path: '/v1/studies/x' }],
    ['a body value', { ...base, body: { title: 'B', expectedRevision: 1 } }],
    ['expectedRevision', { ...base, body: { title: 'A', expectedRevision: 2 } }],
    ['an extra body field', { ...base, body: { ...base.body, extra: true } }],
  ])('changes when %s changes', (_, changed) => {
    expect(requestFingerprint(changed)).not.toBe(requestFingerprint(base));
  });

  it('treats a missing body as null', () => {
    expect(requestFingerprint({ method: 'POST', path: '/x', body: undefined })).toBe(
      requestFingerprint({ method: 'POST', path: '/x', body: null }),
    );
  });
});
