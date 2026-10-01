import { UnsupportedMediaTypeException } from '@nestjs/common';
import { isStateChangingMethod, type RequestLike } from './http-request';

/**
 * True when a state-changing request (any method but GET/HEAD/OPTIONS, the same set
 * `requireTrustedOrigin` checks) must be refused because it is not JSON: it carries a body or
 * a Content-Type, and that Content-Type is not `application/json`.
 *
 * Why: browsers send `application/x-www-form-urlencoded`, `multipart/form-data`, and `text/plain`
 * cross-site without a CORS preflight (an auto-submitting HTML form is a top-level navigation),
 * and the browser accepts a SameSite=Lax `Set-Cookie` from that response. An attacker's form
 * could therefore sign a victim into the attacker's account (login CSRF) or sign them out. Only
 * `application/json` forces a preflight, which the CORS allowlist then refuses, and a form cannot
 * send it. So every /v1 mutation is JSON-only. Bodyless requests with no Content-Type (e.g.
 * a non-browser client calling logout) are allowed.
 */
export function isNonJsonMutation(req: RequestLike): boolean {
  if (!isStateChangingMethod(req.method)) return false;
  const contentType = req.headers['content-type'];
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
  if (contentType === undefined && !hasBody) return false;
  const mediaType = typeof contentType === 'string' ? contentType.split(';')[0] : undefined;
  return mediaType?.trim().toLowerCase() !== 'application/json';
}

/**
 * Express middleware registered in `configureApp` before Nest's body parsers, so a non-JSON body
 * on a mutation is never parsed (the urlencoded parser is unreachable for it). The 415 goes
 * through the global filter and so uses the shared error envelope.
 */
export function requireJsonBody(req: RequestLike, _res: unknown, next: (error?: unknown) => void) {
  next(isNonJsonMutation(req) ? new UnsupportedMediaTypeException() : undefined);
}
