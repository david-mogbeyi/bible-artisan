import { describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint } from './fingerprint';

describe('canonicalJson', () => {
  it('sorts object keys recursively, including inside arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('keeps array order significant, at every depth', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: [[1, 2], [3]] })).not.toBe(canonicalJson({ a: [[3], [1, 2]] }));
    expect(canonicalJson({ a: [[{ y: 1, x: 2 }]] })).toBe('{"a":[[{"x":2,"y":1}]]}');
  });

  it('drops undefined members like JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serializes scalars as JSON', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
  });

  it('keeps an own __proto__ member (as JSON.parse creates it), top-level and nested', () => {
    expect(canonicalJson(JSON.parse('{"a":1,"__proto__":{"x":1}}'))).toBe(
      '{"__proto__":{"x":1},"a":1}',
    );
    expect(canonicalJson(JSON.parse('{"n":{"__proto__":2}}'))).toBe('{"n":{"__proto__":2}}');
  });
});

describe('requestFingerprint', () => {
  const STUDY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const base = {
    method: 'POST',
    route: '/v1/studies/:studyId',
    params: { studyId: STUDY },
    body: { title: 'A', expectedRevision: 1 },
  };
  const withBody = (json: string) => requestFingerprint({ ...base, body: JSON.parse(json) });

  it('is a 64-character hex SHA-256', () => {
    expect(requestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores body key order and method case', () => {
    expect(
      requestFingerprint({ ...base, method: 'post', body: { expectedRevision: 1, title: 'A' } }),
    ).toBe(requestFingerprint(base));
  });

  it.each([
    ['method', { ...base, method: 'PATCH' }],
    ['route', { ...base, route: '/v1/studies/:studyId/archive' }],
    ['a param', { ...base, params: { studyId: '00000000-0000-4000-8000-000000000000' } }],
    ['a body value', { ...base, body: { title: 'B', expectedRevision: 1 } }],
    ['expectedRevision', { ...base, body: { title: 'A', expectedRevision: 2 } }],
    ['an extra body field', { ...base, body: { ...base.body, extra: true } }],
  ])('changes when %s changes', (_, changed) => {
    expect(requestFingerprint(changed)).not.toBe(requestFingerprint(base));
  });

  it('treats a missing body as null', () => {
    expect(requestFingerprint({ ...base, body: undefined })).toBe(
      requestFingerprint({ ...base, body: null }),
    );
  });

  it('distinguishes bodies that differ only by an own __proto__ key, top-level and nested', () => {
    expect(withBody('{"title":"A","__proto__":{"x":1}}')).not.toBe(withBody('{"title":"A"}'));
    expect(withBody('{"n":{"__proto__":1,"a":1}}')).not.toBe(withBody('{"n":{"a":1}}'));
    expect(withBody('{"title":"A","__proto__":1}')).not.toBe(
      withBody('{"title":"A","__proto__":2}'),
    );
  });

  it('ignores key order at every depth, inside nested arrays too', () => {
    expect(withBody('{"a":[{"x":1,"y":[{"q":1,"p":2}]}],"b":2}')).toBe(
      withBody('{"b":2,"a":[{"y":[{"p":2,"q":1}],"x":1}]}'),
    );
    expect(withBody('{"a":[1,[2,3]]}')).not.toBe(withBody('{"a":[1,[3,2]]}'));
  });

  it('compares Unicode strings code unit for code unit (escapes are the same string)', () => {
    expect(withBody('{"title":"Ῥωμαίους 9:1 — “conscience” 🙏"}')).toBe(
      withBody(
        '{"title":"\\u1fec\\u03c9\\u03bc\\u03b1\\u03af\\u03bf\\u03c5\\u03c2 9:1 \\u2014 \\u201cconscience\\u201d \\ud83d\\ude4f"}',
      ),
    );
    // No Unicode normalization: NFC and NFD spellings are different text.
    expect(withBody('{"title":"\\u00e9"}')).not.toBe(withBody('{"title":"e\\u0301"}'));
    expect(withBody('{"é":1,"e":2}')).toBe(withBody('{"e":2,"é":1}'));
  });

  it('treats 1, 1.0 and 1e0 as the same number (intended: same JSON value), but not "1"', () => {
    const one = withBody('{"expectedRevision":1}');
    expect(withBody('{"expectedRevision":1.0}')).toBe(one);
    expect(withBody('{"expectedRevision":1e0}')).toBe(one);
    expect(withBody('{"expectedRevision":10E-1}')).toBe(one);
    expect(withBody('{"expectedRevision":"1"}')).not.toBe(one);
    expect(withBody('{"expectedRevision":1.5}')).not.toBe(one);
  });
});
