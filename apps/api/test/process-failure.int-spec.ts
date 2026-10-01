import { spawn } from 'node:child_process';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { SENTINEL } from './fixtures/leaky-failing-migration/29990104000000_fails_with_row_detail';

const API_DIR = path.resolve(__dirname, '..');
const TSX = path.join(API_DIR, 'node_modules/.bin/tsx');

interface RunResult {
  code: number | null;
  output: string;
}

/** Runs an entry file with tsx and the given env, capturing stdout + stderr together. */
function run(entry: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [entry, ...args], {
      cwd: API_DIR,
      // The parent's env (PATH, USER for pg's default role, ...) with the variables under test.
      env: { ...process.env, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

function jsonLines(output: string): unknown[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

const FAILURE_LINE = {
  level: 'fatal',
  pid: expect.any(Number),
  timestamp: expect.any(Number),
  message: 'process_failed',
  context: 'Process',
};

/**
 * BIB-13 / NFR-PRIV-001: a process that fails to start (or a migration run that fails) writes ONE
 * content-free JSON line and exits non-zero, instead of Node's dump of the error with its
 * message, stack, SQL, bound parameters, and PostgreSQL detail.
 */
// Each test cold-starts tsx and compiles an entry point's import graph: well under a second
// normally, but allow for a loaded CI machine.
describe('process failure output', { timeout: 20_000 }, () => {
  // A config whose only problem is NODE_ENV; the URL carries a password that must not be printed.
  const badConfig = {
    NODE_ENV: 'bogus',
    DATABASE_URL: 'postgres://ba:SENTINEL-password@127.0.0.1:1/x',
  };

  it.each([
    ['api', 'src/main.ts'],
    ['worker', 'src/worker.ts'],
  ])(
    '%s: invalid config is one JSON line naming the variable, then exit 1',
    async (name, entry) => {
      const { code, output } = await run(entry, [], badConfig);
      expect(code).toBe(1);
      expect(jsonLines(output)).toStrictEqual([
        {
          ...FAILURE_LINE,
          entrypoint: name,
          errorType: 'InvalidConfigError',
          variables: ['NODE_ENV'],
        },
      ]);
      expect(output).not.toContain('SENTINEL');
      expect(output).not.toContain('bogus');
    },
  );

  describe('migrate CLI', () => {
    let db: Database;
    const url = loadEnv().DATABASE_URL;

    beforeAll(() => {
      db = createDatabase(url);
    });

    afterAll(async () => {
      await db.close();
    });

    it('logs a failed migration by name, error classes, and SQLSTATE only, then exits 1', async () => {
      const { code, output } = await run(
        'src/database/migrate.ts',
        ['latest', '--dir', 'test/fixtures/leaky-failing-migration'],
        { NODE_ENV: 'test', DATABASE_URL: url },
      );
      expect(code).toBe(1);
      expect(jsonLines(output)).toStrictEqual([
        {
          ...FAILURE_LINE,
          entrypoint: 'migrate',
          errorType: 'MigrationError',
          causeType: 'UniqueConstraintError',
          code: '23505',
          migration: '29990104000000_fails_with_row_detail.ts',
          direction: 'up',
        },
      ]);
      // The unique violation's message, SQL, and `detail` all quote the sentinel row value.
      expect(output).not.toContain(SENTINEL);
      expect(output).not.toMatch(/migration_leak_probe|INSERT|Key \(/);

      // And the failed migration rolled back completely.
      const tables = await db.query(
        `SELECT tablename FROM pg_tables WHERE tablename = 'migration_leak_probe'`,
        { type: QueryTypes.SELECT },
      );
      expect(tables).toStrictEqual([]);
    });
  });
});
