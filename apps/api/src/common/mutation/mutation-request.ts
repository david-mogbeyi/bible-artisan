import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeySchema,
} from '@bible-artisan/contracts';
import { ValidationError } from '../errors/domain-errors';

/** What `MutationService` needs from the HTTP request. Built by `@MutationRequest()`. */
export interface MutationRequestInfo {
  /** Lower-cased UUID from the `Idempotency-Key` header, or null when the client sent none. */
  idempotencyKey: string | null;
  method: string;
  /** Path without the query string. */
  path: string;
  /** The raw parsed JSON body. */
  body: unknown;
}

interface RequestLike {
  method: string;
  originalUrl: string;
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
  return {
    idempotencyKey: parseIdempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()]),
    method: request.method.toUpperCase(),
    path: request.originalUrl.split('?')[0] ?? '',
    body: request.body,
  };
}

/** Param decorator for mutation handlers: `@MutationRequest() mutation: MutationRequestInfo`. */
export const MutationRequest = createParamDecorator(
  (_: unknown, context: ExecutionContext): MutationRequestInfo =>
    mutationRequestInfo(context.switchToHttp().getRequest<RequestLike>()),
);

interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * Applies a `MutationService` result to the response (use with `@Res({ passthrough: true })`)
 * and returns the body for Nest to serialize: the original status, plus `Idempotent-Replayed:
 * true` when the body is a replay.
 */
export function sendMutationResult(
  response: ResponseLike,
  result: { status: number; body: Record<string, unknown>; replayed: boolean },
): Record<string, unknown> {
  response.status(result.status);
  if (result.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  return result.body;
}
