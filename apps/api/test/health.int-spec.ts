import { createServer, type Server as NetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@bible-artisan/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { DATABASE } from '../src/database/database.module';
import { shippedMigrationNames } from '../src/database/migrator';
import { SHIPPED_MIGRATIONS } from '../src/health/health.controller';
import { checkReadiness, READINESS_TIMEOUT_MS } from '../src/health/readiness';
import { createTestApp } from './app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READY = { status: 'ok', database: 'up', migrations: 'current' };
const DB_DOWN = { status: 'unavailable', database: 'down', migrations: 'unknown' };

/** An app whose DATABASE provider is `db` instead of the test database. */
function appWithDatabase(db: Database): Promise<INestApplication<Server>> {
  return createTestApp(undefined, {
    override: (builder) => builder.overrideProvider(DATABASE).useValue(db),
  });
}

describe('GET /v1/health (readiness) and GET /v1/health/live (liveness)', () => {
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
      app = await appWithDatabase(createDatabase('postgres://ba:secret@127.0.0.1:1/unreachable'));
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
    let silent: NetServer;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      // Accepts TCP connections and never answers the PostgreSQL startup message.
      silent = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const { port } = silent.address() as AddressInfo;
      app = await appWithDatabase(createDatabase(`postgres://127.0.0.1:${port}/hung`));
    });

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
      await app.close();
    });

    it('answers readiness 503 within its timeout instead of hanging', async () => {
      const started = Date.now();
      const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
      const elapsed = Date.now() - started;
      expect(res.body).toStrictEqual(DB_DOWN);
      expect(elapsed).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(READINESS_TIMEOUT_MS + 1500);
    });
  });

  describe('checkReadiness', () => {
    let db: Database;

    beforeAll(() => {
      db = createDatabase(loadEnv().DATABASE_URL);
    });

    afterAll(async () => {
      await db.close();
    });

    it('treats a database with no migration table as pending, without creating it', async () => {
      await db.query(
        'DROP SCHEMA IF EXISTS readiness_empty CASCADE; CREATE SCHEMA readiness_empty',
      );
      const url = new URL(loadEnv().DATABASE_URL);
      url.searchParams.set('options', '-c search_path=readiness_empty');
      const empty = createDatabase(url.toString());
      try {
        expect(await checkReadiness(empty, shippedMigrationNames())).toStrictEqual({
          report: { status: 'unavailable', database: 'up', migrations: 'pending' },
          failure: 'MigrationsPending',
        });
        const [tables] = await db.query(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'readiness_empty'`,
        );
        expect(tables).toStrictEqual([{ n: 0 }]);
      } finally {
        await empty.close();
        await db.query('DROP SCHEMA readiness_empty CASCADE');
      }
    });

    it('ignores migrations the database has but this build does not ship', async () => {
      expect(await checkReadiness(db, shippedMigrationNames().slice(0, 1))).toStrictEqual({
        report: READY,
      });
    });
  });
});
