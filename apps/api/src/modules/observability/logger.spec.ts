import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppLogger, enabledLogLevels } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Captures what the logger writes to stdout and stderr (errors go to stderr). */
function captureAll(): string[] {
  const lines: string[] = [];
  const capture = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  return lines;
}

/** Captures what the logger writes to stdout. */
function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe('enabledLogLevels', () => {
  it('maps info to Nest log and enables every more severe level', () => {
    expect(enabledLogLevels('info')).toStrictEqual(['log', 'warn', 'error', 'fatal']);
    expect(enabledLogLevels('error')).toStrictEqual(['error', 'fatal']);
    expect(enabledLogLevels('verbose')).toHaveLength(6);
  });
});

describe('createAppLogger', () => {
  it('writes one JSON object per line in production, with structured fields at the top level', () => {
    const lines = captureStdout();
    createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' }).log(
      'http_request',
      { route: '/v1/me', status: 200 },
      'HttpRequest',
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toStrictEqual({
      level: 'log',
      pid: process.pid,
      timestamp: expect.any(Number),
      message: 'http_request',
      context: 'HttpRequest',
      route: '/v1/me',
      status: 200,
    });
  });

  it('drops levels below LOG_LEVEL', () => {
    const lines = captureStdout();
    createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'warn' }).log('ignored');
    expect(lines).toStrictEqual([]);
  });

  it('uses the readable format outside production', () => {
    const lines = captureStdout();
    createAppLogger({ NODE_ENV: 'development', LOG_LEVEL: 'info' }).log('hello', 'Ctx');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Nest]');
    expect(lines[0]).toContain('hello');
    expect(lines[0]?.trimStart().startsWith('{')).toBe(false);
  });

  it.each(['error', 'fatal'] as const)(
    'reduces an Error passed to %s to its class, without message or stack',
    (level) => {
      const lines = captureAll();
      const error = new TypeError('SENTINEL insert into note values (Romans 8:28)');
      createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' })[level](
        error,
        'ExceptionHandler',
      );
      expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
        {
          level,
          pid: process.pid,
          timestamp: expect.any(Number),
          message: 'unhandled_error',
          context: 'ExceptionHandler',
          errorType: 'TypeError',
        },
      ]);
      expect(lines.join('')).not.toMatch(/SENTINEL|Romans|at /);
    },
  );
});
