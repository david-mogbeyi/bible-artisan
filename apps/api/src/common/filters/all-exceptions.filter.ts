import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { randomUUID } from 'node:crypto';
import { ConnectionError } from 'sequelize';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../errors/domain-errors';

/**
 * Minimal structural typing for the underlying HTTP request/response so this filter doesn't need
 * a direct `express` type dependency (apps/api depends on @nestjs/platform-express, not express
 * types, directly).
 */
interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface ExpressLikeResponse {
  status(code: number): { json(body: unknown): void };
}

/** PRD §24: only dependency outages and rate limits are safe to retry automatically. */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.SERVICE_UNAVAILABLE,
  HttpStatus.TOO_MANY_REQUESTS,
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A client-supplied `x-correlation-id` is echoed and logged, so only a bounded opaque value (a
 * UUID) is accepted. Anything else (missing, empty, repeated, over-long, free text) is replaced
 * by a freshly generated ID, so a client cannot inject arbitrary content into logs.
 */
export function resolveCorrelationId(header: string | string[] | undefined): string {
  return typeof header === 'string' && UUID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * Maps every thrown exception to the shared error envelope (PRD §24), the only shape a 4xx/5xx
 * JSON body may take from /v1. `retryable` follows §24: stale-revision conflicts (409) are retried
 * only after explicit user reconciliation, so they are NOT retryable; only dependency outages
 * (503) and rate limits (429) are.
 *
 * Logs only the error code, status, correlation ID, and the thrown value's constructor name
 * (NFR-PRIV-001): never `message`, `fieldErrors`, or stack text, which could carry user content.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<ExpressLikeResponse>();
    const request = ctx.getRequest<ExpressLikeRequest>();

    const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
    const { status, envelope } = this.toEnvelope(exception, correlationId);

    this.logger.error(
      `${envelope.code} status=${status} correlationId=${correlationId} errorType=${errorTypeOf(exception)}`,
    );

    response.status(status).json(envelope);
  }

  private toEnvelope(
    exception: unknown,
    correlationId: string,
  ): { status: number; envelope: ErrorEnvelope } {
    if (exception instanceof RevisionMissingError) {
      return {
        status: HttpStatus.PRECONDITION_REQUIRED,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      };
    }

    if (exception instanceof RevisionConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
          currentRevision: exception.currentRevision,
        },
      };
    }

    if (exception instanceof ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        envelope: {
          code: exception.code,
          message: exception.message,
          ...(exception.fieldErrors ? { fieldErrors: exception.fieldErrors } : {}),
          retryable: false,
          correlationId,
        },
      };
    }

    if (exception instanceof NotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        envelope: {
          code: HttpStatus[status] ?? 'ERROR',
          message: exception.message,
          retryable: RETRYABLE_HTTP_STATUSES.has(status),
          correlationId,
        },
      };
    }

    // Covers every Sequelize connection failure (refused, timed out, pool acquire timeout, ...).
    if (exception instanceof ConnectionError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        envelope: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'A required service is temporarily unavailable',
          retryable: true,
          correlationId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      envelope: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: false,
        correlationId,
      },
    };
  }
}

/** Content-free diagnostic: the thrown value's class name only (e.g. `TypeError`). */
function errorTypeOf(exception: unknown): string {
  if (exception instanceof Error) return exception.constructor.name;
  return exception === null ? 'null' : typeof exception;
}
