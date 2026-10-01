import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSessionToken } from './session-cookie';
import type { SessionService } from './session.service';

type Next = (error?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** True when the request declares a body (a length, or a chunked transfer). */
function declaresBody(req: IncomingMessage): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined
  );
}

/**
 * Runs `parser` (a body parser with a larger limit than the default, BIB-23's note routes) only
 * for a request whose session cookie resolves to a live session. Anyone else gets `next()` with
 * the body untouched, so Nest's default parser (100 kB) reads it later and the global
 * `SessionGuard` answers 401: an anonymous client can never make the server buffer more than the
 * default limit, whatever route it targets.
 *
 * The check is the same `SessionService.resolve` the guard uses (one indexed lookup of the
 * token's hash); a missing or malformed cookie costs no query at all. A body-less request (GET)
 * skips it. The guard still decides authentication afterwards: this only picks the parser.
 */
export function parseBodyWhenSignedIn(sessions: SessionService, parser: Middleware): Middleware {
  // Named so Nest's `jsonParser`-name check (see bootstrap) never mistakes it for its own parser.
  return function signedInBodyParser(req, res, next) {
    if (!declaresBody(req)) return next();
    const token = readSessionToken(req.headers.cookie);
    if (!token) return next();
    sessions.resolve(token).then((session) => {
      if (session) parser(req, res, next);
      else next();
    }, next);
  };
}
