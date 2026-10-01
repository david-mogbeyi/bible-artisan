import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@bible-artisan/contracts';
import { ValidationError } from '../errors/domain-errors';
import { isUuid } from '../validation/uuid';

/** What `MutationService` needs from the HTTP request. Built by `@MutationRequest()`. */
export interface MutationRequestInfo {
  /** Lower-cased UUID from the `Idempotency-Key` header, or null when the client sent none. */
  idempotencyKey: string | null;
  method: string;
  /**
   * The matched route pattern, e.g. `/v1/studies/:studyId/nodes/:nodeId`, not the raw URL, so
   * case, trailing-slash, and percent-encoding variants of one resource fingerprint alike.
   */
  route: string;
  /** Route params, decoded by the router; UUIDs lower-cased. */
  params: Record<string, string>;
  /** The raw parsed JSON body. */
  body: unknown;
}

interface RequestLike {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/**
 * Optional `Idempotency-Key` header → lower-cased UUID, or null when absent. Anything else
 * (not a UUID, empty, or sent twice, which Node joins into one comma-separated value) is a 400
 * with fixed copy; the submitted value is never echoed (NFR-PRIV-001).
 */
export function parseIdempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new ValidationError('Invalid request', {
      [IDEMPOTENCY_KEY_HEADER]: ['Must be a UUID'],
    });
  }
  return parsed.data.toLowerCase();
}

export function mutationRequestInfo(request: RequestLike): MutationRequestInfo {
  const pattern = request.route?.path;
  // Only a request the router matched to a handler has a pattern; anything else is a wiring bug.
  if (typeof pattern !== 'string') {
    throw new Error('@MutationRequest() needs a request matched to a route');
  }
  return {
    idempotencyKey: parseIdempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()]),
    method: request.method.toUpperCase(),
    route: `${request.baseUrl ?? ''}${pattern}`,
    params: normalizedParams(request.params ?? {}),
    body: request.body,
  };
}

/** Router-decoded params with UUIDs lower-cased (they are stored and compared lower-case). */
function normalizedParams(params: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    normalized[name] = isUuid(value) ? value.toLowerCase() : value;
  }
  return normalized;
}

/** Param decorator for mutation handlers: `@MutationRequest() mutation: MutationRequestInfo`. */
export const MutationRequest = createParamDecorator(
  (_: unknown, context: ExecutionContext): MutationRequestInfo =>
    mutationRequestInfo(context.switchToHttp().getRequest<RequestLike>()),
);
