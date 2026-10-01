import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessLogFields,
  loggedMethod,
  type LoggedRequest,
  type LoggedResponse,
  requestLogging,
  routePatternOf,
} from './request-logging';

const ID = '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60';

class FakeResponse extends EventEmitter implements LoggedResponse {
  statusCode = 200;
  headersSent = false;
  writableFinished = false;
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routePatternOf', () => {
  it('returns the matched route pattern', () => {
    expect(routePatternOf({ method: 'GET', headers: {}, route: { path: '/v1/me' } })).toBe(
      '/v1/me',
    );
  });

  it.each([
    ['no route matched', undefined],
    ["Nest's not-found catch-all", { path: '*path' }],
    ['a non-string path', { path: /regex/ }],
  ])('returns unmatched for %s', (_label, route) => {
    expect(routePatternOf({ method: 'GET', headers: {}, route })).toBe('unmatched');
  });
});

describe('loggedMethod', () => {
  it('keeps standard methods and collapses anything else', () => {
    expect(loggedMethod('PATCH')).toBe('PATCH');
    expect(loggedMethod('Romans 9:1')).toBe('OTHER');
  });
});

describe('accessLogFields', () => {
  it('builds exactly the allowlisted fields, nothing from the URL or body', () => {
    const req = {
      method: 'POST',
      headers: { 'x-correlation-id': ID, cookie: 'ba_session=secret' },
      route: { path: '/v1/studies/:studyId' },
      url: '/v1/studies/1?q=Romans+9',
      body: { note: 'private' },
    } as LoggedRequest;
    const res = new FakeResponse();
    res.statusCode = 409;
    expect(accessLogFields(req, res, 12.3, false)).toStrictEqual({
      method: 'POST',
      route: '/v1/studies/:studyId',
      status: 409,
      durationMs: 12.3,
      correlationId: ID,
    });
    res.headersSent = true;
    expect(accessLogFields(req, res, 1, true)).toStrictEqual({
      method: 'POST',
      route: '/v1/studies/:studyId',
      status: 409,
      durationMs: 1,
      correlationId: ID,
      aborted: true,
    });
  });
});

describe('requestLogging', () => {
  it('sets the correlation header and logs once, when the response finishes', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const req: LoggedRequest = { method: 'GET', headers: { 'x-correlation-id': ID } };
    const res = new FakeResponse();
    const next = vi.fn();

    requestLogging(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.headers.get('X-Correlation-Id')).toBe(ID);
    expect(log).not.toHaveBeenCalled();

    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    expect(log.mock.calls).toStrictEqual([
      [
        'http_request',
        {
          method: 'GET',
          route: 'unmatched',
          status: 200,
          durationMs: expect.any(Number),
          correlationId: ID,
        },
      ],
    ]);
  });

  it('logs an aborted request with no status (not the default 200) when nothing was sent', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const res = new FakeResponse();
    requestLogging({ method: 'GET', headers: { 'x-correlation-id': ID } }, res, vi.fn());
    res.emit('close');
    res.emit('finish');
    expect(log.mock.calls).toStrictEqual([
      [
        'http_request',
        {
          method: 'GET',
          route: 'unmatched',
          status: null,
          durationMs: expect.any(Number),
          correlationId: ID,
          aborted: true,
        },
      ],
    ]);
  });

  it('keeps the status of an aborted request whose headers were already sent', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const res = new FakeResponse();
    requestLogging({ method: 'GET', headers: {} }, res, vi.fn());
    res.statusCode = 206;
    res.headersSent = true;
    res.emit('close');
    expect(log.mock.calls[0]?.[1]).toMatchObject({ status: 206, aborted: true });
  });
});
