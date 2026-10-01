/**
 * The post-sign-in destination from an untrusted `next` query value. Only same-origin relative
 * paths are allowed (a single leading `/`, no `//` or `/\` that browsers treat as another host,
 * no control characters). Anything else, and the sign-in page itself, falls back to home.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/';
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  if (next === '/sign-in' || next.startsWith('/sign-in?') || next.startsWith('/sign-in/')) {
    return '/';
  }
  return next;
}
