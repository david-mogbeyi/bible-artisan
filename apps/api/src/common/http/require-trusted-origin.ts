import { ForbiddenException } from '@nestjs/common';

interface RequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Methods that must never change state. Everything else (POST, PUT, PATCH, DELETE, and any other
 * method) is checked, so a method nobody thought of fails closed rather than open.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a state-changing request comes from a browser context outside the allowlist and must
 * be refused (CSRF, PRD §29: "CSRF protection covers cookie-authenticated mutations").
 *
 * - `Origin` present: it must exactly equal an allowed origin. `null` (sandboxed iframes, some
 *   redirects, `file:` pages) and a repeated header never match.
 * - `Origin` absent: refuse only when `Sec-Fetch-Site` says `cross-site`. Browsers send `Origin`
 *   on every cross-origin request and on same-origin POST/PUT/PATCH/DELETE, so a request with
 *   neither header comes from a non-browser client, which holds no victim's cookie.
 *
 * This is the second layer behind `requireJsonBody` (JSON-only mutations force a CORS preflight
 * that the allowlist refuses), so a CORS or content-type gap alone cannot reopen CSRF.
 */
export function isUntrustedMutation(
  req: RequestLike,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    return typeof origin !== 'string' || !allowedOrigins.has(origin);
  }
  const fetchSite = req.headers['sec-fetch-site'];
  return typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'cross-site';
}

/**
 * Express middleware registered in `configureApp` ahead of every other middleware, body parser,
 * guard and handler, for public routes (sign-in) as well as private ones. The 403 goes through
 * the global filter (fixed "Forbidden" envelope; the Origin value is never echoed or logged).
 */
export function requireTrustedOrigin(allowedOrigins: readonly string[]) {
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  return (req: RequestLike, _res: unknown, next: (error?: unknown) => void): void => {
    next(isUntrustedMutation(req, allowed) ? new ForbiddenException() : undefined);
  };
}
