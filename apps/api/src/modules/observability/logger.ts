import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { Env } from '../../config/env';
import { errorTypeOf } from './correlation';

/** Nest's levels from most to least verbose. `LOG_LEVEL=info` is Nest's `log`. */
const LEVELS_BY_VERBOSITY: readonly LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

/** The configured level and every level more severe than it. */
export function enabledLogLevels(level: Env['LOG_LEVEL']): LogLevel[] {
  const threshold = LEVELS_BY_VERBOSITY.indexOf(level === 'info' ? 'log' : level);
  return LEVELS_BY_VERBOSITY.slice(threshold);
}

/** A Nest context name (`ExceptionHandler`), as opposed to a stack trace or free text. */
const CONTEXT_NAME = /^[A-Za-z][\w-]{0,63}$/;

/**
 * Nest's ConsoleLogger, except that an Error passed as the message (Nest's own ExceptionHandler
 * does this when bootstrap fails) is reduced to its class name. Printing it whole would emit its
 * message and stack, which can carry SQL, bound values, or PostgreSQL `detail` (NFR-PRIV-001).
 */
class RedactingConsoleLogger extends ConsoleLogger {
  override error(message: unknown, ...optionalParams: unknown[]): void {
    if (message instanceof Error) super.error(...redactedError(message, optionalParams));
    else super.error(message, ...optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    if (message instanceof Error) super.fatal(...redactedError(message, optionalParams));
    else super.fatal(message, ...optionalParams);
  }
}

/** `unhandled_error` with the class name, keeping only a trailing context name (no stack). */
function redactedError(error: Error, optionalParams: unknown[]): [string, ...unknown[]] {
  const context = optionalParams.at(-1);
  return [
    'unhandled_error',
    { errorType: errorTypeOf(error) },
    ...(typeof context === 'string' && CONTEXT_NAME.test(context) ? [context] : []),
  ];
}

/**
 * The process logger for the API and the worker (BIB-13). Nest's built-in ConsoleLogger, no new
 * dependency (AGENTS.md rule 9). In production every line is one JSON object (level, pid,
 * timestamp, message, context, plus the structured fields a call passes, flattened to the top
 * level) for the platform's log collector; elsewhere it prints the readable format.
 *
 * What gets logged is the caller's responsibility and is allowlisted at each call site (see
 * `requestLogging` and `AllExceptionsFilter`): this logger adds no request data of its own.
 */
export function createAppLogger(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): ConsoleLogger {
  const json = env.NODE_ENV === 'production';
  return new RedactingConsoleLogger({
    logLevels: enabledLogLevels(env.LOG_LEVEL),
    json,
    colors: !json,
    ...(json ? { flattenParams: true } : {}),
  });
}
