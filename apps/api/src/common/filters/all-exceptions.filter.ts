import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { ConnectionError, TimeoutError } from 'sequelize';
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
  headersSent: boolean;
  status(code: number): { json(body: unknown): void };
  destroy(): void;
}

/** PRD §24: only dependency outages and rate limits are safe to retry automatically. */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.SERVICE_UNAVAILABLE,
  HttpStatus.TOO_MANY_REQUESTS,
]);

/**
 * PostgreSQL SQLSTATEs meaning the connection itself went away (class 08 is matched by prefix):
 * admin shutdown, crash shutdown, cannot connect now. Plus the socket-level codes node-postgres
 * surfaces when the server drops a connection mid-query.
 */
const CONNECTION_LOSS_CODES: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
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

    if (response.headersSent) {
      // Part of a response already went out, so no envelope can follow it. Destroy the response
      // rather than end() it, so the client sees a failed (not a silently truncated) response.
      this.logger.error(
        `${envelope.code} status=${status} correlationId=${correlationId} errorType=${errorTypeOf(exception)} headersSent=true`,
      );
      response.destroy();
      return;
    }

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

    // Nest HttpExceptions and errors from the HTTP layer below Nest (body-parser / http-errors:
    // 413 too large, 415, 400 aborted request, ...) keep their status, but their message is
    // replaced by the standard reason phrase: framework messages can echo request content (Nest
    // wraps body-parser's JSON SyntaxError text, which quotes the body, in a BadRequestException;
    // its 404 says "Cannot GET <path>"). Meaningful client messages come from domain errors above.
    const httpStatus =
      exception instanceof HttpException ? exception.getStatus() : exposedHttpStatusOf(exception);
    if (httpStatus !== undefined) {
      return {
        status: httpStatus,
        envelope: {
          code: HttpStatus[httpStatus] ?? 'ERROR',
          message: STATUS_CODES[httpStatus] ?? 'Request error',
          retryable: RETRYABLE_HTTP_STATUSES.has(httpStatus),
          correlationId,
        },
      };
    }

    if (isDependencyUnavailable(exception)) {
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

/**
 * The HTTP status of a non-Nest error that carries one (http-errors shape: numeric `status` or
 * `statusCode` plus `expose: true`, which http-errors sets for client errors). Anything else is
 * not trusted to pick the response status.
 */
function exposedHttpStatusOf(exception: unknown): number | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { status, statusCode, expose } = exception as Error & {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  const code = typeof status === 'number' ? status : statusCode;
  if (expose !== true || typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  return code >= 400 && code <= 599 ? code : undefined;
}

/**
 * True when the database is unreachable rather than the query being wrong: any Sequelize
 * ConnectionError (refused, host not found, pool acquire timeout, ...), a Sequelize TimeoutError,
 * or a driver error whose code says the connection was lost or the server is shutting down.
 */
function isDependencyUnavailable(exception: unknown): boolean {
  if (exception instanceof ConnectionError || exception instanceof TimeoutError) return true;
  if (!(exception instanceof Error)) return false;
  const withCodes = exception as Error & {
    code?: unknown;
    original?: { code?: unknown };
    parent?: { code?: unknown };
  };
  return [withCodes.code, withCodes.original?.code, withCodes.parent?.code].some(
    (code) =>
      typeof code === 'string' && (code.startsWith('08') || CONNECTION_LOSS_CODES.has(code)),
  );
}

/** Content-free diagnostic: the thrown value's class name only (e.g. `TypeError`). */
function errorTypeOf(exception: unknown): string {
  if (exception instanceof Error) return exception.constructor.name;
  return exception === null ? 'null' : typeof exception;
}
