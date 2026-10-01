import { describe, expect, it } from 'vitest';
import { HTTP_URL_MAX_LENGTH, httpUrlSchema } from './url';

describe('httpUrlSchema', () => {
  it.each([
    'https://example.com',
    'http://example.com/path?q=1#frag',
    'HTTPS://Example.com/Romans',
    'https://example.com:8443/a',
  ])('accepts %s', (url) => {
    expect(httpUrlSchema.parse(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(httpUrlSchema.parse('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/file',
    '//evil.test/path',
    'example.com',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://exa mple.com/',
    'https://example.com/\njavascript:alert(1)',
    'https://',
    'http:/example.com',
    'not a url',
    '',
  ])('rejects %j without echoing it', (url) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toStrictEqual(['must be an http or https URL without credentials']);
  });

  it('rejects an over-length URL', () => {
    const url = `https://example.com/${'a'.repeat(HTTP_URL_MAX_LENGTH)}`;
    const result = httpUrlSchema.safeParse(url);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain(`must be at most ${HTTP_URL_MAX_LENGTH} characters`);
  });

  it('rejects non-strings', () => {
    expect(httpUrlSchema.safeParse(42).success).toBe(false);
    expect(httpUrlSchema.safeParse(null).success).toBe(false);
  });
});
