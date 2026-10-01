import { ConsoleLogger } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import { MigrationError } from 'umzug';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidConfigError, loadEnv } from '../../config/env';
import { failProcess, failureFields } from './entrypoint';

afterEach(() => {
  vi.restoreAllMocks();
});

const SENTINEL = 'SENTINEL-row-value';

/** A unique violation as Sequelize raises it: message, SQL, parameters and detail quote the row. */
function uniqueViolation(): UniqueConstraintError {
  const original = Object.assign(new Error(`duplicate key value ${SENTINEL}`), {
    code: '23505',
    detail: `Key (v)=(${SENTINEL}) already exists.`,
    sql: `INSERT INTO t VALUES ('${SENTINEL}')`,
    parameters: [SENTINEL],
  });
  return new UniqueConstraintError({ message: `Validation error ${SENTINEL}`, parent: original });
}

describe('failureFields', () => {
  it('names the invalid variables of a config error, never their values', () => {
    let error: unknown;
    try {
      loadEnv({ NODE_ENV: 'prod', DATABASE_URL: 'not a url' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidConfigError);
    expect(failureFields('api', error)).toStrictEqual({
      entrypoint: 'api',
      errorType: 'InvalidConfigError',
      variables: ['NODE_ENV', 'DATABASE_URL'],
    });
  });

  it('describes a failed migration by name, classes, and SQLSTATE only', () => {
    const error = new MigrationError(
      { name: '2026_x.ts', direction: 'up', context: {} },
      uniqueViolation(),
    );
    const fields = failureFields('migrate', error);
    expect(fields).toStrictEqual({
      entrypoint: 'migrate',
      errorType: 'MigrationError',
      causeType: 'UniqueConstraintError',
      code: '23505',
      migration: '2026_x.ts',
      direction: 'up',
    });
    expect(JSON.stringify(fields)).not.toContain(SENTINEL);
  });

  it('keeps a socket error code, and drops a code that is free text', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(failureFields('worker', refused)).toStrictEqual({
      entrypoint: 'worker',
      errorType: 'Error',
      code: 'ECONNREFUSED',
    });
    const odd = Object.assign(new Error('x'), { code: `${SENTINEL} with spaces` });
    expect(failureFields('worker', odd)).toStrictEqual({
      entrypoint: 'worker',
      errorType: 'Error',
    });
  });

  it('handles thrown non-errors', () => {
    expect(failureFields('api', 'a string')).toStrictEqual({
      entrypoint: 'api',
      errorType: 'string',
    });
  });
});

describe('failProcess', () => {
  it('writes one JSON fatal line without the error text, then exits 1', () => {
    const lines: string[] = [];
    const capture = (chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const exit = vi.fn();
    const logger = new ConsoleLogger({ json: true, colors: false, flattenParams: true });

    failProcess(
      'migrate',
      new MigrationError({ name: '2026_x.ts', direction: 'up', context: {} }, uniqueViolation()),
      { logger, exit },
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
      {
        level: 'fatal',
        pid: process.pid,
        timestamp: expect.any(Number),
        message: 'process_failed',
        context: 'Process',
        entrypoint: 'migrate',
        errorType: 'MigrationError',
        causeType: 'UniqueConstraintError',
        code: '23505',
        migration: '2026_x.ts',
        direction: 'up',
      },
    ]);
    expect(lines.join('')).not.toContain(SENTINEL);
  });
});
