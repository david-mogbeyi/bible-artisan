import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { randomUUID } from 'node:crypto';
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

/**
 * Maps every thrown exception to the shared error envelope (PRD §24) — the only shape a 4xx/5xx
 * JSON body may take from /v1. Logs only the error code, correlation ID, and status (NFR-PRIV-001):
 * never `message`/`fieldErrors`, since a later ticket's validation echoes could carry user input.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<ExpressLikeResponse>();
    const request = ctx.getRequest<ExpressLikeRequest>();

    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ?? randomUUID();

    const { status, envelope } = this.toEnvelope(exception, correlationId);

    this.logger.error(`${envelope.code} correlationId=${correlationId} status=${status}`);

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
          retryable: true,
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
          retryable: status >= 500,
          correlationId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      envelope: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: true,
        correlationId,
      },
    };
  }
}
