import type { LoggerService } from '@nestjs/common';
import { InvalidConfigError } from '../../config/env';
import { errorTypeOf } from './correlation';
import { createAppLogger } from './logger';

/** Which process failed. */
export type EntrypointName = 'api' | 'worker' | 'migrate';

/**
 * Everything a process-failure line may carry (NFR-PRIV-001). Each value is a class name, a fixed
 * identifier, or a pattern-checked code, never an error's message, stack, SQL, bound parameters,
 * or PostgreSQL `detail` (which quotes row values, e.g. a unique-violation key).
 */
export interface FailureFields {
  entrypoint: EntrypointName;
  errorType: string;
  /** Class of the wrapped error, when there is one (Umzug's MigrationError wraps the DB error). */
  causeType?: string;
  /** SQLSTATE (`23505`) or socket/errno code (`ECONNREFUSED`). */
  code?: string;
  /** The migration that failed (a file name from this repository), for `migrate`. */
  migration?: string;
  direction?: 'up' | 'down';
  /** Names (never values) of the invalid environment variables. */
  variables?: string[];
}

const SAFE_CODE = /^[A-Z0-9_]{1,24}$/;
const SAFE_NAME = /^[\w.-]{1,200}$/;
const SAFE_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** First pattern-safe `code` on the error, its cause, or the driver error Sequelize wraps. */
function codeOf(error: unknown): string | undefined {
  const cause = prop(error, 'cause');
  const candidates = [error, prop(error, 'original'), cause, prop(cause, 'original')];
  for (const candidate of candidates) {
    const code = prop(candidate, 'code');
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  }
  return undefined;
}

/** The content-free description of a failure that stopped a process. */
export function failureFields(entrypoint: EntrypointName, error: unknown): FailureFields {
  const fields: FailureFields = { entrypoint, errorType: errorTypeOf(error) };
  const cause = prop(error, 'cause');
  if (cause !== undefined) fields.causeType = errorTypeOf(cause);
  const code = codeOf(error);
  if (code) fields.code = code;

  // Umzug's MigrationError: `migration` is `{ name, direction }`.
  const migration = prop(error, 'migration');
  const name = prop(migration, 'name');
  const direction = prop(migration, 'direction');
  if (typeof name === 'string' && SAFE_NAME.test(name)) fields.migration = name;
  if (direction === 'up' || direction === 'down') fields.direction = direction;

  if (error instanceof InvalidConfigError) {
    fields.variables = error.variables.filter((variable) => SAFE_VARIABLE.test(variable));
  }
  return fields;
}

/**
 * Always JSON, whatever NODE_ENV says: the configuration that would choose the format may be
 * exactly what failed to load.
 */
function fatalLogger(): LoggerService {
  return createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'error' });
}

/** Exit once stdout and stderr have flushed (pipe writes are asynchronous on some platforms). */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

export interface EntrypointDeps {
  logger?: LoggerService;
  exit?: (code: number) => void;
}

/** Logs a failure that stops the process as ONE JSON line (`process_failed`), then exits 1. */
export function failProcess(
  entrypoint: EntrypointName,
  error: unknown,
  { logger = fatalLogger(), exit = exitAfterFlush }: EntrypointDeps = {},
): void {
  logger.fatal?.('process_failed', failureFields(entrypoint, error), 'Process');
  exit(1);
}

/**
 * Runs a process's `main` (API bootstrap, worker bootstrap, migration CLI). A thrown startup error
 * (invalid config, unreachable database, a failed migration) and any later unhandled rejection
 * or uncaught exception become one content-free JSON line and a non-zero exit, instead of Node's
 * default dump of the error with its message, stack, SQL, parameters, and PostgreSQL detail.
 */
export async function runEntrypoint(
  entrypoint: EntrypointName,
  main: () => Promise<void>,
  deps: EntrypointDeps = {},
): Promise<void> {
  const onFatal = (error: unknown): void => failProcess(entrypoint, error, deps);
  process.on('unhandledRejection', onFatal);
  process.on('uncaughtException', onFatal);
  try {
    await main();
  } catch (error) {
    onFatal(error);
  }
}
