import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { Env } from '../../config/env';

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
  return new ConsoleLogger({
    logLevels: enabledLogLevels(env.LOG_LEVEL),
    json,
    colors: !json,
    ...(json ? { flattenParams: true } : {}),
  });
}
