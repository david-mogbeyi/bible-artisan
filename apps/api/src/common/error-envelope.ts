import { HttpStatus } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from './domain-errors';

/** Pure mapping: domain exception -> (status, envelope body minus correlationId). Unit-tested. */
export function mapDomainErrorToEnvelope(error: unknown): {
  status: number;
  body: Omit<ErrorEnvelope, 'correlationId'>;
} {
  if (error instanceof NotFoundError) {
    return {
      status: HttpStatus.NOT_FOUND,
      body: { code: error.code, message: error.message, retryable: false },
    };
  }
  if (error instanceof RevisionMissingError) {
    return {
      status: HttpStatus.PRECONDITION_REQUIRED,
      body: { code: error.code, message: error.message, retryable: true },
    };
  }
  if (error instanceof RevisionConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      body: {
        code: error.code,
        message: error.message,
        retryable: true,
        currentRevision: error.currentRevision,
      },
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true },
  };
}
