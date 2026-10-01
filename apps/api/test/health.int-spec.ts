import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@bible-artisan/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { DATABASE } from '../src/database/database.module';
import { shippedMigrationNames } from '../src/database/migrator';
import { READINESS_CONNECTION, SHIPPED_MIGRATIONS } from '../src/health/health.controller';
import {
  checkReadiness,
  READINESS_BUDGET_MS,
  READINESS_CACHE_MS,
  READINESS_TIMEOUT_MS,
} from '../src/health/readiness';
import { createTestApp } from './app';
import { hostAndPort, startTcpProxy, type TcpProxy } from './support/tcp-proxy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READY = { status: 'ok', database: 'up', migrations: 'current' };
const DB_DOWN = { status: 'unavailable', database: 'down', migrations: 'unknown' };

/** An app whose readiness probe connects to `connectionString` instead of the test database. */
function appWithReadinessDatabase(connectionString: string): Promise<INestApplication<Server>> {
  return createTestApp(undefined, {
    override: (builder) =>
      builder.overrideProvider(READINESS_CONNECTION).useValue({ connectionString }),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /v1/health (readiness) and GET /v1/health/live (liveness)', () => {
  const url = loadEnv().DATABASE_URL;

  describe('against the migrated test database', () => {
    let app: INestApplication<Server>;

    beforeAll(async () => {
      app = await createTestApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports ready, uncached, with a correlation ID', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
      expect(res.body).toStrictEqual(READY);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toMatch(UUID);
    });

    it('reports alive', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health/live').expect(200);
      expect(res.body).toStrictEqual({ status: 'ok' });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('when a shipped migration is not applied', () => {
    let app: INestApplication<Server>;

    beforeAll(async () => {
      app = await createTestApp(undefined, {
        override: (builder) =>
          builder
            .overrideProvider(SHIPPED_MIGRATIONS)
            .useValue([...shippedMigrationNames(), '29990101000000_not_applied_yet.ts']),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers 503 with migrations pending, so the deployment is unhealthy', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
      expect(res.body).toStrictEqual({
        status: 'unavailable',
        database: 'up',
        migrations: 'pending',
      });
    });
  });

  describe('when the database refuses connections', () => {
    let app: INestApplication<Server>;

    beforeAll(async () => {
      // Port 1 on localhost: nothing listens, so every connection attempt is refused.
      app = await appWithReadinessDatabase('postgres://ba:secret@127.0.0.1:1/unreachable');
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers readiness 503 with the database down and no connection details', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
      expect(res.body).toStrictEqual(DB_DOWN);
      expect(res.text).not.toMatch(/secret|127\.0\.0\.1|unreachable|ECONN/);
    });

    it('still answers liveness 200, because liveness never touches the database', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health/live').expect(200);
      expect(res.body).toStrictEqual({ status: 'ok' });
    });
  });

  describe('when the database hangs', () => {
    let app: INestApplication<Server>;
    let proxy: TcpProxy;

    beforeAll(async () => {
      // Accepts TCP connections and never answers the PostgreSQL startup message.
      proxy = await startTcpProxy(hostAndPort(url));
      proxy.mode = 'blackhole';
      app = await appWithReadinessDatabase(proxy.urlFor(url));
    });

    afterAll(async () => {
      await app.close();
      await proxy.close();
    });

    it('answers 503 within the 2 s budget, response included, and drops its connection', async () => {
      const started = Date.now();
      const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
      const elapsed = Date.now() - started;
      expect(res.body).toStrictEqual(DB_DOWN);
      expect(elapsed).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(READINESS_BUDGET_MS);
      // The probe's own client gave up on the hung connect: nothing is left holding it.
      await expect.poll(() => proxy.openSockets).toBe(0);
    });
  });

  describe('when the request pool is saturated', () => {
    let app: INestApplication<Server>;
    let db: Database;

    beforeAll(async () => {
      app = await createTestApp();
      db = app.get<Database>(DATABASE);
    });

    afterAll(async () => {
      await app.close();
    });

    it('still reports a healthy database ready, because the probe never queues on the pool', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = 0;
      // The pool's 10 connections, each held open by a transaction.
      const holders = Array.from({ length: 10 }, () =>
        db.transaction(async () => {
          await db.query('SELECT 1');
          holding += 1;
          await gate;
        }),
      );
      try {
        await expect.poll(() => holding).toBe(10);
        // Saturated: a further request query waits for a connection.
        let queuedDone = false;
        const queued = db.query('SELECT 1').then(() => {
          queuedDone = true;
        });
        await sleep(200);
        expect(queuedDone).toBe(false);

        const started = Date.now();
        const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
        expect(res.body).toStrictEqual(READY);
        expect(Date.now() - started).toBeLessThan(READINESS_BUDGET_MS);
        expect(queuedDone).toBe(false);

        release();
        await Promise.all([...holders, queued]);
      } finally {
        release();
        await Promise.allSettled(holders);
      }
    });
  });

  describe('under a flood of probes', () => {
    let app: INestApplication<Server>;
    let proxy: TcpProxy;

    beforeAll(async () => {
      // Forwards to the test database and counts every connection the probe opens.
      proxy = await startTcpProxy(hostAndPort(url));
      app = await appWithReadinessDatabase(proxy.urlFor(url));
      // Listen once, so 25 concurrent supertest requests share the server instead of each
      // starting it (and adding a listener).
      await app.listen(0, '127.0.0.1');
    });

    afterAll(async () => {
      await app.close();
      await proxy.close();
    });

    it('runs one database check for concurrent probes and caches it briefly', async () => {
      const probe = (): Promise<request.Response> =>
        request(app.getHttpServer()).get('/v1/health').expect(200);

      const concurrent = await Promise.all(Array.from({ length: 25 }, probe));
      expect(concurrent.map((res) => res.body as unknown)).toStrictEqual(
        Array.from({ length: 25 }, () => READY),
      );
      expect(proxy.connections).toBe(1);

      // Within the cache window: answered without touching the database.
      await probe();
      expect(proxy.connections).toBe(1);

      // After it: a fresh check.
      await sleep(READINESS_CACHE_MS + 100);
      await probe();
      expect(proxy.connections).toBe(2);
    });
  });

  describe('checkReadiness', () => {
    let db: Database;

    beforeAll(() => {
      db = createDatabase(url);
    });

    afterAll(async () => {
      await db.close();
    });

    it('treats a database with no migration table as pending, without creating it', async () => {
      await db.query(
        'DROP SCHEMA IF EXISTS readiness_empty CASCADE; CREATE SCHEMA readiness_empty',
      );
      const empty = new URL(url);
      empty.searchParams.set('options', '-c search_path=readiness_empty');
      try {
        expect(
          await checkReadiness({ connectionString: empty.toString() }, shippedMigrationNames()),
        ).toStrictEqual({
          report: { status: 'unavailable', database: 'up', migrations: 'pending' },
          failure: 'MigrationsPending',
        });
        const [tables] = await db.query(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'readiness_empty'`,
        );
        expect(tables).toStrictEqual([{ n: 0 }]);
      } finally {
        await db.query('DROP SCHEMA readiness_empty CASCADE');
      }
    });

    it('ignores migrations the database has but this build does not ship', async () => {
      expect(
        await checkReadiness({ connectionString: url }, shippedMigrationNames().slice(0, 1)),
      ).toStrictEqual({ report: READY });
    });

    it('reports a refused connection by class and code only', async () => {
      expect(
        await checkReadiness({ connectionString: 'postgres://ba:secret@127.0.0.1:1/x' }, []),
      ).toStrictEqual({ report: DB_DOWN, failure: 'Error', code: 'ECONNREFUSED' });
    });
  });
});
