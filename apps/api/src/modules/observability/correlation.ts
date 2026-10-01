import { randomUUID } from 'node:crypto';
import { isUuid } from '../../common/validation/uuid';

/** The request header a client may use to supply its own correlation ID (lower-cased by Node). */
export const CORRELATION_ID_REQUEST_HEADER = 'x-correlation-id';

/**
 * A client-supplied `x-correlation-id` is echoed and logged, so only a bounded opaque value (a
 * UUID) is accepted. Anything else (missing, empty, repeated, over-long, free text) is replaced
 * by a freshly generated ID, so a client cannot inject arbitrary content into logs.
 */
export function resolveCorrelationId(header: string | string[] | undefined): string {
  return isUuid(header) ? header : randomUUID();
}

/** The slice of a request the correlation helpers read. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * One correlation ID per request object, assigned by `requestLogging` (the first middleware) and
 * read back by the exception filter, so the envelope, the `X-Correlation-Id` response header, and
 * every log line agree. A WeakMap rather than a property on the request: nothing else can
 * overwrite it, and it is collected with the request.
 */
const correlationIds = new WeakMap<object, string>();

/**
 * The request's correlation ID: resolved on first call (by `requestLogging`, the first
 * middleware) and remembered, so every later caller (the exception filter, the access log) gets
 * the same one. If the middleware did not run (a filter exercised without the HTTP stack), the
 * first caller resolves it instead; there is still exactly one ID per request.
 */
export function correlationIdOf(req: RequestWithHeaders): string {
  const existing = correlationIds.get(req);
  if (existing !== undefined) return existing;
  const id = resolveCorrelationId(req.headers[CORRELATION_ID_REQUEST_HEADER]);
  correlationIds.set(req, id);
  return id;
}

/** Content-free diagnostic: the thrown value's class name only (e.g. `TypeError`). */
export function errorTypeOf(exception: unknown): string {
  if (exception instanceof Error) return exception.constructor.name;
  return exception === null ? 'null' : typeof exception;
}
