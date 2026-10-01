/** Session cookie wire format (PRD §29: Secure, HttpOnly, SameSite=Lax). */
export const SESSION_COOKIE_NAME = 'ba_session';

/** 32 random bytes, base64url without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The session token from a `Cookie` header, or undefined when absent or malformed. Only a value
 * shaped like a token is returned, so arbitrary cookie content never reaches a query.
 */
export function readSessionToken(cookieHeader: string | string[] | undefined): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : undefined;
  }
  return undefined;
}

export function serializeSessionCookie(
  token: string,
  { maxAgeSeconds, secure }: { maxAgeSeconds: number; secure: boolean },
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}

export function clearSessionCookie({ secure }: { secure: boolean }): string {
  return serializeSessionCookie('', { maxAgeSeconds: 0, secure });
}
