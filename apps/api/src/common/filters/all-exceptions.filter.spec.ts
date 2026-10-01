import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  type ArgumentsHost,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import {
  ConnectionAcquireTimeoutError,
  ConnectionError,
  ConnectionRefusedError,
  DatabaseError,
  TimeoutError,
} from 'sequelize';
import { AllExceptionsFilter, resolveCorrelationId } from './all-exceptions.filter';
import {
  DependencyUnavailableError,
  IdempotencyKeyReusedError,
  NotFoundError,
  OtpError,
  RateLimitedError,
  RevisionConflictError,
  RevisionMissingError,
  UnauthenticatedError,
  ValidationError,
} from '../errors/domain-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(
  exception: unknown,
  headers: Record<string, string | string[]> = {},
): { status: number; body: ErrorEnvelope } {
  return runWithHeaders(exception, headers).result;
}

function runWithHeaders(
  exception: unknown,
  headers: Record<string, string | string[]> = {},
): { result: { status: number; body: ErrorEnvelope }; setHeaders: [string, string][] } {
  const json = vi.fn<(body: ErrorEnvelope) => void>();
  const status = vi.fn<(code: number) => { json: typeof json }>().mockReturnValue({ json });
  const setHeader = vi.fn<(name: string, value: string) => void>();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent: false, status, setHeader, destroy: vi.fn() }),
      getRequest: () => ({ headers }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  const code = status.mock.calls[0]?.[0];
  const body = json.mock.calls[0]?.[0];
  if (code === undefined || body === undefined) throw new Error('filter did not respond');
  return { result: { status: code, body }, setHeaders: setHeader.mock.calls };
}

/** A driver error as node-postgres raises it (SQLSTATE or socket code on `code`). */
function pgError(code: string): Error & { code: string; sql: string } {
  return Object.assign(new Error('driver detail'), { code, sql: 'SELECT 1' });
}

/** An error shaped like body-parser's http-errors instances. */
function httpLayerError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, statusCode: status, expose: true });
}

const DEPENDENCY_UNAVAILABLE = {
  status: 503,
  body: {
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'A required service is temporarily unavailable',
    retryable: true,
    correlationId: expect.stringMatching(UUID),
  },
};

let logSpy: MockInstance<Logger['error']>;

beforeEach(() => {
  logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AllExceptionsFilter', () => {
  it('maps NotFoundError to 404, not retryable', () => {
    expect(run(new NotFoundError('nope'))).toStrictEqual({
      status: 404,
      body: {
        code: 'NOT_FOUND',
        message: 'nope',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('maps ValidationError to 400 and includes fieldErrors', () => {
    expect(run(new ValidationError('bad', { title: ['required'] }))).toStrictEqual({
      status: 400,
      body: {
        code: 'VALIDATION',
        message: 'bad',
        fieldErrors: { title: ['required'] },
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('maps RevisionMissingError to 428, not retryable', () => {
    expect(run(new RevisionMissingError())).toStrictEqual({
      status: 428,
      body: {
        code: 'REVISION_MISSING',
        message: 'expectedRevision is required',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('maps RevisionConflictError to 409 with currentRevision, not retryable (PRD §24)', () => {
    expect(run(new RevisionConflictError(3))).toStrictEqual({
      status: 409,
      body: {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
        currentRevision: 3,
      },
    });
  });

  it('maps UnauthenticatedError to 401, not retryable', () => {
    expect(run(new UnauthenticatedError())).toStrictEqual({
      status: 401,
      body: {
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it.each([
    ['OTP_INVALID', 'The code is not correct'],
    ['OTP_EXPIRED', 'The code has expired or was already used'],
    ['OTP_ATTEMPTS_EXHAUSTED', 'Too many attempts for this code'],
  ] as const)('maps OtpError %s to 422 with a fixed message', (code, message) => {
    expect(run(new OtpError(code))).toStrictEqual({
      status: 422,
      body: { code, message, retryable: false, correlationId: expect.stringMatching(UUID) },
    });
  });

  it('maps IdempotencyKeyReusedError to 422 with a fixed message, not retryable', () => {
    expect(run(new IdempotencyKeyReusedError())).toStrictEqual({
      status: 422,
      body: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for a different request',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('maps RateLimitedError to 429, retryable, with a Retry-After header', () => {
    expect(runWithHeaders(new RateLimitedError(42))).toStrictEqual({
      result: {
        status: 429,
        body: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again later',
          retryable: true,
          correlationId: expect.stringMatching(UUID),
        },
      },
      setHeaders: [['Retry-After', '42']],
    });
  });

  it('maps DependencyUnavailableError (e.g. the OTP provider) to 503, retryable', () => {
    expect(run(new DependencyUnavailableError())).toStrictEqual(DEPENDENCY_UNAVAILABLE);
  });

  it.each([
    ['ConnectionError', new ConnectionError(new Error('down'))],
    ['ConnectionRefusedError', new ConnectionRefusedError(new Error('refused'))],
  ])('maps a database %s to 503, retryable', (_name, error) => {
    expect(run(error)).toStrictEqual({
      status: 503,
      body: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        retryable: true,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it.each([
    ['ConnectionAcquireTimeoutError', new ConnectionAcquireTimeoutError(new Error('pool'))],
    ['TimeoutError', new TimeoutError(pgError('57014'))],
    ['admin shutdown (57P01)', new DatabaseError(pgError('57P01'))],
    ['crash shutdown (57P02)', new DatabaseError(pgError('57P02'))],
    ['cannot connect now (57P03)', new DatabaseError(pgError('57P03'))],
    ['connection failure (08006)', new DatabaseError(pgError('08006'))],
    ['connection does not exist (08003)', new DatabaseError(pgError('08003'))],
    ['socket reset mid-query (ECONNRESET)', new DatabaseError(pgError('ECONNRESET'))],
    ['an unwrapped driver error (57P01)', pgError('57P01')],
  ])('maps %s to 503 DEPENDENCY_UNAVAILABLE, retryable', (_name, error) => {
    expect(run(error)).toStrictEqual(DEPENDENCY_UNAVAILABLE);
  });

  it('does not map an ordinary query error (e.g. unique violation 23505) to 503', () => {
    expect(run(new DatabaseError(pgError('23505'))).status).toBe(500);
  });

  it.each([
    [413, 'PAYLOAD_TOO_LARGE', 'Payload Too Large'],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported Media Type'],
    [400, 'BAD_REQUEST', 'Bad Request'],
  ])('maps an http-errors %i to its status with a content-free message', (status, code, msg) => {
    expect(run(httpLayerError(status, 'Unexpected token in "Romans 8:28 note"'))).toStrictEqual({
      status,
      body: { code, message: msg, retryable: false, correlationId: expect.stringMatching(UUID) },
    });
  });

  it('ignores a status on an error that is not marked expose: true', () => {
    expect(run(Object.assign(new Error('x'), { status: 404 })).status).toBe(500);
  });

  it('destroys the response instead of writing an envelope once headers are sent', () => {
    const status = vi.fn();
    const destroy = vi.fn();
    const correlationId = '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60';
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ headersSent: true, status, destroy }),
        getRequest: () => ({ headers: { 'x-correlation-id': correlationId } }),
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(new TypeError('private note text'), host);

    expect(status).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls).toStrictEqual([
      [
        `INTERNAL_ERROR status=500 correlationId=${correlationId} errorType=TypeError headersSent=true`,
      ],
    ]);
  });

  it('replaces a Nest HttpException message with the reason phrase', () => {
    expect(run(new BadRequestException('Unexpected token in "Romans 8:28 note"'))).toStrictEqual({
      status: 400,
      body: {
        code: 'BAD_REQUEST',
        message: 'Bad Request',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('maps a Nest 503 HttpException to retryable', () => {
    expect(run(new ServiceUnavailableException()).body.retryable).toBe(true);
  });

  it('maps an unrecognized error to 500, not retryable', () => {
    expect(run(new Error('boom'))).toStrictEqual({
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: false,
        correlationId: expect.stringMatching(UUID),
      },
    });
  });

  it('logs code, status, correlation ID and error class name, never the message', () => {
    const correlationId = '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60';
    run(new TypeError('Romans 14:23 private note text'), { 'x-correlation-id': correlationId });
    expect(logSpy.mock.calls).toStrictEqual([
      [`INTERNAL_ERROR status=500 correlationId=${correlationId} errorType=TypeError`],
    ]);
  });
});

describe('resolveCorrelationId', () => {
  it('echoes a well-formed UUID', () => {
    const id = '0B7C0A8E-5D7B-4C1E-9A3F-2F7E1C9D4B60';
    expect(resolveCorrelationId(id)).toBe(id);
    expect(run(new NotFoundError(), { 'x-correlation-id': id }).body.correlationId).toBe(id);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['free text', 'abc-123'],
    ['log injection', '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60\nforged line'],
    ['oversized', 'a'.repeat(10_000)],
    ['repeated header', ['0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60']],
  ])('generates a fresh UUID when the header is %s', (_label, header) => {
    const id = resolveCorrelationId(header);
    expect(id).toMatch(UUID);
    expect(id).not.toBe(header);
  });
});
