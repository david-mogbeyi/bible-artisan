import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { STATUS_CODES } from 'node:http';
import { ConnectionError, TimeoutError } from 'sequelize';
import {
  AnchorInvalidError,
  DependencyUnavailableError,
  IdempotencyKeyReusedError,
  NotFoundError,
  OtpError,
  QuestionNotFoundError,
  RateLimitedError,
  ReferenceInvalidError,
  ReferenceNotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  SearchQueryIsReferenceError,
  StudyUnchangedError,
  TagLimitExceededError,
  UnauthenticatedError,
  ValidationError,
} from '../errors/domain-errors';
import { correlationIdOf, errorTypeOf } from '../../modules/observability/correlation';

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
  setHeader(name: string, value: string): void;
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

/**
 * PostgreSQL SQLSTATEs for a transaction PostgreSQL aborted for a reason other than the request
 * being wrong: 40P01 deadlock_detected, 40001 serialization_failure, 57014 query_canceled (our
 * statement_timeout, e.g. a waiter behind a long-held row lock), 25P03
 * idle_in_transaction_session_timeout. The whole transaction (domain writes, event, receipt) was
 * rolled back, so retrying the identical request with the same Idempotency-Key is safe.
 */
const TRANSIENT_CONFLICT_CODES: ReadonlySet<string> = new Set(['40P01', '40001', '57014', '25P03']);

/** Seconds a client should wait before retrying a transient conflict. */
const TRANSIENT_CONFLICT_RETRY_AFTER_SECONDS = 1;

/**
 * Maps every thrown exception to the shared error envelope (PRD §24), the only shape a 4xx/5xx
 * JSON body may take from /v1. `retryable` follows §24: stale-revision conflicts (409) are retried
 * only after explicit user reconciliation, so they are NOT retryable; only dependency outages
 * (503), rate limits (429), and transient transaction aborts (503 `TRANSIENT_CONFLICT`) are.
 *
 * Deadlocks and serialization failures map to 503 + `retryable: true` + `Retry-After`, not 409:
 * §24 reserves 409 for revision/uniqueness conflicts, which the web client answers with the
 * reconciliation UI (Keep Server / Save My Version) and never retries automatically. A deadlock is
 * not a user conflict; the database was momentarily unable to apply a valid request, which is
 * what 503 means in §24's list, and the save queue should simply retry with the same key.
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

    // The ID `requestLogging` assigned at the start of this request, so the envelope, the
    // X-Correlation-Id header, and every log line for the request agree.
    const correlationId = correlationIdOf(request);
    const { status, envelope, retryAfterSeconds } = this.toEnvelope(exception, correlationId);
    // Allowlisted fields only: the code is a fixed constant or a status name, never input.
    const fields = {
      code: envelope.code,
      status,
      correlationId,
      errorType: errorTypeOf(exception),
    };

    if (response.headersSent) {
      // Part of a response already went out, so no envelope can follow it. Destroy the response
      // rather than end() it, so the client sees a failed (not a silently truncated) response.
      this.logger.error('http_error', { ...fields, headersSent: true });
      response.destroy();
      return;
    }

    // 4xx are expected client outcomes (warn); 5xx are server faults (error).
    if (status >= 500) this.logger.error('http_error', fields);
    else this.logger.warn('http_error', fields);

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    response.status(status).json(envelope);
  }

  private toEnvelope(
    exception: unknown,
    correlationId: string,
  ): { status: number; envelope: ErrorEnvelope; retryAfterSeconds?: number } {
    if (exception instanceof UnauthenticatedError) {
      return {
        status: HttpStatus.UNAUTHORIZED,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      };
    }

    if (
      exception instanceof OtpError ||
      exception instanceof IdempotencyKeyReusedError ||
      exception instanceof ReferenceInvalidError ||
      exception instanceof ReferenceNotFoundError ||
      exception instanceof AnchorInvalidError ||
      exception instanceof SearchQueryIsReferenceError ||
      exception instanceof QuestionNotFoundError ||
      exception instanceof StudyUnchangedError ||
      exception instanceof TagLimitExceededError
    ) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      };
    }

    if (exception instanceof RateLimitedError) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        envelope: {
          code: exception.code,
          message: exception.message,
          retryable: true,
          correlationId,
        },
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }

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

    if (isTransientConflict(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        envelope: {
          code: 'TRANSIENT_CONFLICT',
          message: 'The request collided with a concurrent change. Retry it',
          retryable: true,
          correlationId,
        },
        retryAfterSeconds: TRANSIENT_CONFLICT_RETRY_AFTER_SECONDS,
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

/** SQLSTATE codes on the error itself or on the driver error Sequelize wraps. */
function sqlStatesOf(exception: unknown): string[] {
  if (!(exception instanceof Error)) return [];
  const withCodes = exception as Error & {
    code?: unknown;
    original?: { code?: unknown };
    parent?: { code?: unknown };
  };
  return [withCodes.code, withCodes.original?.code, withCodes.parent?.code].filter(
    (code): code is string => typeof code === 'string',
  );
}

/** True when PostgreSQL aborted the transaction for a transient reason (see TRANSIENT_CONFLICT_CODES). */
function isTransientConflict(exception: unknown): boolean {
  return sqlStatesOf(exception).some((code) => TRANSIENT_CONFLICT_CODES.has(code));
}

/**
 * True when the database is unreachable rather than the query being wrong: any Sequelize
 * ConnectionError (refused, host not found, pool acquire timeout, ...), a Sequelize TimeoutError,
 * or a driver error whose code says the connection was lost or the server is shutting down.
 */
function isDependencyUnavailable(exception: unknown): boolean {
  if (exception instanceof DependencyUnavailableError) return true;
  if (exception instanceof ConnectionError || exception instanceof TimeoutError) return true;
  return sqlStatesOf(exception).some(
    (code) => code.startsWith('08') || CONNECTION_LOSS_CODES.has(code),
  );
}
