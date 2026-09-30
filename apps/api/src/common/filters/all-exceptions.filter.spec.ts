import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { type ArgumentsHost, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { ConnectionError, ConnectionRefusedError } from 'sequelize';
import { AllExceptionsFilter, resolveCorrelationId } from './all-exceptions.filter';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../errors/domain-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(
  exception: unknown,
  headers: Record<string, string | string[]> = {},
): { status: number; body: ErrorEnvelope } {
  const json = vi.fn<(body: ErrorEnvelope) => void>();
  const status = vi.fn<(code: number) => { json: typeof json }>().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ headers }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  const code = status.mock.calls[0]?.[0];
  const body = json.mock.calls[0]?.[0];
  if (code === undefined || body === undefined) throw new Error('filter did not respond');
  return { status: code, body };
}

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
