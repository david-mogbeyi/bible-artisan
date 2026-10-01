import { createHash } from 'node:crypto';

/**
 * Canonical JSON: `JSON.stringify` with every object's keys sorted by UTF-16 code unit
 * (`Array.prototype.sort` default), recursively. Array order is significant and kept. Members whose
 * value is `undefined` (or a function/symbol) are dropped, exactly as `JSON.stringify` drops them,
 * and `toJSON` (e.g. on Date) is honoured first. So two bodies that parse to the same JSON value
 * canonicalize identically regardless of key order or whitespace on the wire.
 *
 * Sorted copies are built on null-prototype objects: on a plain `{}`, assigning an own
 * `__proto__` key (which `JSON.parse` creates as an ordinary member) would set the prototype
 * instead and silently drop the member, so `{"__proto__":1,"a":1}` and `{"a":1}` would collide.
 *
 * Numbers are compared as values, not wire spellings: `1`, `1.0`, and `1e0` all parse to the same
 * JavaScript number and canonicalize to `1`. That is intended: they are the same JSON value, and
 * the Zod schemas downstream cannot tell them apart either. Strings are compared code unit for
 * code unit, with no Unicode normalization (NFC "é" and NFD "é" differ), as the stored text would.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    const record = current as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  });
}

export interface FingerprintedRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** The matched route pattern, e.g. `/v1/studies/:studyId`, never the raw URL. */
  route: string;
  /** Route params (router-decoded, UUIDs lower-cased). IDs are part of the fingerprint. */
  params: Record<string, string>;
  /** The raw parsed JSON body (not the Zod output), so every submitted field counts. */
  body: unknown;
}

/**
 * The request fingerprint stored as `mutation_receipt.request_hash`: SHA-256 hex of the canonical
 * JSON of `{ method, route, params, body }`. Same key + different fingerprint is rejected (422).
 * Using the route pattern and normalized params (not the URL) means `/V1/…`, a trailing slash, an
 * upper-case or percent-encoded ID of the same resource are the same request and replay. A missing
 * body hashes as `null`.
 */
export function requestFingerprint({ method, route, params, body }: FingerprintedRequest): string {
  const canonical = canonicalJson({
    method: method.toUpperCase(),
    route,
    params,
    body: body ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
