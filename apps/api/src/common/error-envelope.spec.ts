import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from './domain-errors';
import { mapDomainErrorToEnvelope } from './error-envelope';

describe('mapDomainErrorToEnvelope', () => {
  it('maps NotFoundError to 404', () => {
    expect(mapDomainErrorToEnvelope(new NotFoundError('gone'))).toStrictEqual({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'gone', retryable: false },
    });
  });

  it('maps RevisionMissingError to 428', () => {
    expect(mapDomainErrorToEnvelope(new RevisionMissingError())).toStrictEqual({
      status: 428,
      body: { code: 'REVISION_MISSING', message: 'expectedRevision is required', retryable: true },
    });
  });

  it('maps RevisionConflictError to 409 with currentRevision', () => {
    expect(mapDomainErrorToEnvelope(new RevisionConflictError(7, 'stale'))).toStrictEqual({
      status: 409,
      body: { code: 'REVISION_CONFLICT', message: 'stale', retryable: true, currentRevision: 7 },
    });
  });

  it('maps ValidationError to 400 and includes fieldErrors when present', () => {
    expect(
      mapDomainErrorToEnvelope(new ValidationError('bad input', { title: ['required'] })),
    ).toStrictEqual({
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        retryable: false,
        fieldErrors: { title: ['required'] },
      },
    });
  });

  it('maps ValidationError without fieldErrors by omitting the field', () => {
    expect(mapDomainErrorToEnvelope(new ValidationError('bad input'))).toStrictEqual({
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: 'bad input', retryable: false },
    });
  });

  it('maps an unrecognized error to a retryable 500', () => {
    expect(mapDomainErrorToEnvelope(new Error('boom'))).toStrictEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true },
    });
  });
});
