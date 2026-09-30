import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../errors/domain-errors';

function createHost(headers: Record<string, string> = {}): {
  host: ArgumentsHost;
  json: ReturnType<typeof vi.fn<(body: ErrorEnvelope) => void>>;
  status: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn<(body: ErrorEnvelope) => void>();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status };
  const request = { headers };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('AllExceptionsFilter', () => {
  it('maps NotFoundError to 404', () => {
    const filter = new AllExceptionsFilter();
    const { host, json, status } = createHost();
    filter.catch(new NotFoundError('nope'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'nope', retryable: false }),
    );
  });

  it('maps ValidationError to 400 and includes fieldErrors', () => {
    const filter = new AllExceptionsFilter();
    const { host, json, status } = createHost();
    filter.catch(new ValidationError('bad', { title: ['required'] }), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VALIDATION', fieldErrors: { title: ['required'] } }),
    );
  });

  it('maps RevisionMissingError to 428', () => {
    const filter = new AllExceptionsFilter();
    const { host, status } = createHost();
    filter.catch(new RevisionMissingError(), host);
    expect(status).toHaveBeenCalledWith(428);
  });

  it('maps RevisionConflictError to 409 with currentRevision', () => {
    const filter = new AllExceptionsFilter();
    const { host, json, status } = createHost();
    filter.catch(new RevisionConflictError(3), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ currentRevision: 3 }));
  });

  it('maps an unrecognized error to 500', () => {
    const filter = new AllExceptionsFilter();
    const { host, status } = createHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(500);
  });

  it('generates a correlation ID when none is supplied, and echoes one when supplied', () => {
    const filter = new AllExceptionsFilter();
    const { host: hostNoHeader, json: jsonNoHeader } = createHost();
    filter.catch(new NotFoundError(), hostNoHeader);
    expect(jsonNoHeader.mock.calls[0]?.[0]?.correlationId).toBeTypeOf('string');

    const { host: hostWithHeader, json: jsonWithHeader } = createHost({
      'x-correlation-id': 'abc-123',
    });
    filter.catch(new NotFoundError(), hostWithHeader);
    expect(jsonWithHeader.mock.calls[0]?.[0]?.correlationId).toBe('abc-123');
  });
});
