import { ConnectionAcquireTimeoutError, ConnectionError, QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, DATABASE_TIMEOUTS, type Database } from '../src/database/database';
import { hostAndPort, startTcpProxy, type TcpProxy } from './support/tcp-proxy';

/**
 * BIB-13: the request pool must not lock up when PostgreSQL hangs. Without a connect timeout, a
 * connect to a server that accepts TCP but never answers stays counted against the pool forever,
 * so every later request times out acquiring even after the database recovers.
 */
describe('createDatabase timeouts', () => {
  const url = loadEnv().DATABASE_URL;

  it('sets the shipped connect timeout and server-side session timeouts', async () => {
    const db = createDatabase(url);
    try {
      expect(db.options.dialectOptions).toMatchObject({
        connectionTimeoutMillis: DATABASE_TIMEOUTS.connectMs,
      });
      const [settings] = await db.query(
        `SELECT current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
        { type: QueryTypes.SELECT },
      );
      expect(settings).toStrictEqual({ statement: '30s', idle: '1min' });
    } finally {
      await db.close();
    }
  });

  it('cancels a runaway statement server-side', async () => {
    const db = createDatabase(url, { ...DATABASE_TIMEOUTS, statementMs: 200 });
    try {
      await expect(db.query('SELECT pg_sleep(5)')).rejects.toMatchObject({
        original: { code: '57014' },
      });
    } finally {
      await db.close();
    }
  });

  describe('against a database that hangs, then recovers', () => {
    let proxy: TcpProxy;
    let db: Database;
    const connectMs = 400;

    beforeAll(async () => {
      proxy = await startTcpProxy(hostAndPort(url));
      db = createDatabase(proxy.urlFor(url), { ...DATABASE_TIMEOUTS, connectMs });
    });

    afterAll(async () => {
      await db.close();
      await proxy.close();
    });

    /** Runs 12 queries (more than the pool's 10 slots) against the hung server. */
    async function queriesWhileHung(): Promise<number> {
      proxy.mode = 'blackhole';
      const started = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => db.query('SELECT 1')),
      );
      for (const result of results) {
        expect(result.status).toBe('rejected');
        const reason = (result as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(ConnectionError);
        expect(reason).not.toBeInstanceOf(ConnectionAcquireTimeoutError);
      }
      // The hung sockets were closed by the client, not left holding pool slots.
      await expect.poll(() => proxy.openSockets).toBe(0);
      return Date.now() - started;
    }

    async function recovers(): Promise<void> {
      proxy.mode = 'forward';
      const rows = await db.query('SELECT 1 AS ok', { type: QueryTypes.SELECT });
      expect(rows).toStrictEqual([{ ok: 1 }]);
    }

    it('fails the first connect within the timeout and recovers', async () => {
      // Sequelize's first connect (its server-version probe) gates every query.
      expect(await queriesWhileHung()).toBeLessThan(connectMs + 1500);
      await recovers();
    });

    it('fails pooled connects within the timeout, frees every slot, and recovers', async () => {
      // The database drops the pool's live connection, then hangs: every query needs a new
      // connect. The first 10 take all slots; the other 2 get one only once those are freed.
      proxy.dropAll();
      // Wait until the pool has discarded the dropped connection (pg reports the reset).
      const pool = (db.connectionManager as unknown as { pool: { size: number } }).pool;
      await expect.poll(() => pool.size).toBe(0);
      const before = proxy.connections;
      const elapsed = await queriesWhileHung();
      // Every query needed a fresh connect (sequelize-pool may start extra ones for queued
      // acquires); none waited out the acquire timeout behind a hung slot.
      expect(proxy.connections - before).toBeGreaterThanOrEqual(12);
      // Two rounds of connect timeouts, far below the 10 s acquire timeout.
      expect(elapsed).toBeLessThan(connectMs * 2 + 1500);
      await recovers();
    });
  });
});
