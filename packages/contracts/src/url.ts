import { z } from 'zod';

// WHATWG `URL` is a global in both Node and browsers, but this package compiles against the
// ES2023 lib only (no DOM or Node types), so declare just the shape used here.
declare const URL: new (input: string) => {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
};

export const HTTP_URL_MAX_LENGTH = 2048;

/**
 * True when `value` contains a space or a C0/C1 control character. Browsers silently strip some
 * of these (tab, newline) while parsing, so `java\tscript:` must never be accepted.
 */
function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isSafeHttpUrl(value: string): boolean {
  if (hasWhitespaceOrControl(value)) return false;
  // The scheme must be spelled out literally, so protocol-relative (`//host`) and scheme-less
  // input is refused rather than resolved against some base.
  if (!/^https?:\/\//i.test(value)) return false;
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * A user-supplied external link (NFR-SEC-002, PRD §29: "external links accept HTTPS/HTTP only").
 * Every stored URL (note links, Source URLs) must pass this schema. It rejects `javascript:`,
 * `data:`, `vbscript:`, `file:`, protocol-relative and scheme-less input, embedded credentials,
 * and whitespace or control characters. Messages name the rule, never the submitted value.
 */
export const httpUrlSchema = z
  .string()
  .trim()
  .max(HTTP_URL_MAX_LENGTH, `must be at most ${HTTP_URL_MAX_LENGTH} characters`)
  .refine(isSafeHttpUrl, 'must be an http or https URL without credentials');
