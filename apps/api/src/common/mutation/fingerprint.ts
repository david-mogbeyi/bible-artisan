import { createHash } from 'node:crypto';

/**
 * Canonical JSON: `JSON.stringify` with every object's keys sorted by UTF-16 code unit
 * (`Array.prototype.sort` default), recursively. Array order is significant and kept. Members whose
 * value is `undefined` (or a function/symbol) are dropped, exactly as `JSON.stringify` drops them,
 * and `toJSON` (e.g. on Date) is honoured first. So two bodies that parse to the same JSON value
 * canonicalize identically regardless of key order or whitespace on the wire.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    const record = current as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  });
}

export interface FingerprintedRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Request path without the query string, e.g. `/v1/studies/<uuid>`. IDs are part of it. */
  path: string;
  /** The raw parsed JSON body (not the Zod output), so every submitted field counts. */
  body: unknown;
}

/**
 * The request fingerprint stored as `mutation_receipt.request_hash`: SHA-256 hex of the canonical
 * JSON of `{ method, path, body }`. Same key + different fingerprint is rejected (422). A missing
 * body hashes as `null`.
 */
export function requestFingerprint({ method, path, body }: FingerprintedRequest): string {
  const canonical = canonicalJson({ method: method.toUpperCase(), path, body: body ?? null });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
