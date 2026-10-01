import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { DATABASE } from '../src/database/database.module';
import { migrateToLatest, shippedMigrationNames } from '../src/database/migrator';
import {
  PINNED_CORPUS,
  READINESS_CONNECTION,
  SHIPPED_MIGRATIONS,
} from '../src/health/health.controller';
import {
  checkReadiness,
  type CorpusPin,
  READINESS_BUDGET_MS,
  READINESS_CACHE_MS,
  READINESS_TIMEOUT_MS,
} from '../src/health/readiness';
import { contentSha256, sha256Hex } from '../src/modules/bible-content/corpus/corpus';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { createTestApp } from './app';
import { hostAndPort, startTcpProxy, type TcpProxy } from './support/tcp-proxy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READY = { status: 'ok', database: 'up', migrations: 'current', corpus: 'ready' };
const DB_DOWN = {
  status: 'unavailable',
  database: 'down',
  migrations: 'unknown',
  corpus: 'unknown',
};

/** The release this build pins (imported by the suite's global setup). */
const PIN: CorpusPin = {
  code: ENGWEBP_RELEASE.code,
  sourceRelease: ENGWEBP_RELEASE.sourceRelease,
  artifactSha256: ENGWEBP_RELEASE.artifactSha256,
  contentSha256: ENGWEBP_RELEASE.contentSha256,
};
/** A release that was never imported: same edition, another artifact. */
const NOT_IMPORTED: CorpusPin = { ...PIN, artifactSha256: '0'.repeat(64) };

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
        corpus: 'ready',
      });
    });
  });

  describe('when the pinned Bible corpus release is not imported', () => {
    let app: INestApplication<Server>;

    beforeAll(async () => {
      app = await createTestApp(undefined, {
        override: (builder) => builder.overrideProvider(PINNED_CORPUS).useValue(NOT_IMPORTED),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers 503 with the corpus missing, so the deployment is unhealthy', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
      expect(res.body).toStrictEqual({
        status: 'unavailable',
        database: 'up',
        migrations: 'current',
        corpus: 'missing',
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
      // The one startup integrity check (awaited during app init) already connected once.
      const atStartup = proxy.connections;
      expect(atStartup).toBe(1);

      const concurrent = await Promise.all(Array.from({ length: 25 }, probe));
      expect(concurrent.map((res) => res.body as unknown)).toStrictEqual(
        Array.from({ length: 25 }, () => READY),
      );
      expect(proxy.connections).toBe(atStartup + 1);

      // Within the cache window: answered without touching the database.
      await probe();
      expect(proxy.connections).toBe(atStartup + 1);

      // After it: a fresh check.
      await sleep(READINESS_CACHE_MS + 100);
      await probe();
      expect(proxy.connections).toBe(atStartup + 2);
    });
  });

  /**
   * Corpus identity and integrity (BIB-14), in a schema of its own so the shared test corpus is
   * never touched: the schema is fully migrated and holds tiny placeholder editions (no Scripture),
   * activated through the normal checked path.
   */
  describe('corpus identity and integrity', () => {
    const SCHEMA = 'readiness_corpus';
    const scopedUrl = (() => {
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
      return scoped.toString();
    })();
    let admin: Database;
    let scopedDb: Database;
    /** An edition with the pinned code, release and artifact, but other content. */
    let impostor: CorpusPin;
    /** A consistent edition, tampered with after it was activated. */
    let tampered: CorpusPin;

    function appFor(pin: CorpusPin): Promise<INestApplication<Server>> {
      return createTestApp(undefined, {
        override: (builder) =>
          builder
            .overrideProvider(READINESS_CONNECTION)
            .useValue({ connectionString: scopedUrl })
            .overrideProvider(PINNED_CORPUS)
            .useValue(pin),
      });
    }

    /** Imports a one-book placeholder edition through the checked activation path. */
    async function placeholderEdition(
      label: Pick<CorpusPin, 'code' | 'sourceRelease' | 'artifactSha256'>,
    ): Promise<CorpusPin> {
      const verses = ['x', 'y'].map((text, i) => ({
        bookCode: 'TST',
        chapter: 1,
        verse: i + 1,
        text,
        textSha256: sha256Hex(text),
      }));
      const superscriptions = [
        { bookCode: 'TST', chapter: 1, beforeVerse: 1, text: 'z', textSha256: sha256Hex('z') },
      ];
      const content = contentSha256(verses, superscriptions);
      await scopedDb.transaction(async (transaction) => {
        const run = (sql: string, bind: unknown[]) =>
          scopedDb.query(sql, { bind, transaction, type: QueryTypes.SELECT });
        const [edition] = await run(
          `INSERT INTO bible_edition (code, name, abbreviation, language, canon, source_url,
             source_release, artifact_sha256, content_sha256, verse_count, superscription_count,
             license_status, attribution, rights_record)
           VALUES ($1, 'x', 'x', 'en', 'protestant', 'https://example.test/a.zip', $2, $3, $4,
             2, 1, 'public_domain', 'x', '{}')
           RETURNING id`,
          [label.code, label.sourceRelease, label.artifactSha256, content],
        );
        const id = (edition as { id: string }).id;
        await run(
          `INSERT INTO bible_book (edition_id, code, sequence, name, abbreviation, chapter_count)
           VALUES ($1, 'TST', 1, 'x', 'x', 1)`,
          [id],
        );
        for (const v of verses) {
          await run(`INSERT INTO bible_verse VALUES ($1, $2, $3, $4, $5, $6)`, [
            id,
            v.bookCode,
            v.chapter,
            v.verse,
            v.text,
            v.textSha256,
          ]);
        }
        for (const d of superscriptions) {
          await run(`INSERT INTO bible_superscription VALUES ($1, $2, $3, $4, $5, $6)`, [
            id,
            d.bookCode,
            d.chapter,
            d.beforeVerse,
            d.text,
            d.textSha256,
          ]);
        }
        await run(`UPDATE bible_edition SET activated_at = now() WHERE id = $1`, [id]);
      });
      return { ...label, contentSha256: content };
    }

    beforeAll(async () => {
      admin = createDatabase(url);
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
      scopedDb = createDatabase(scopedUrl);
      await migrateToLatest(scopedDb);
      impostor = await placeholderEdition(PIN);
      tampered = await placeholderEdition({
        code: 'tampertest',
        sourceRelease: '2099-01-01',
        artifactSha256: sha256Hex('tampertest'),
      });
    });

    afterAll(async () => {
      await scopedDb.close();
      // DROP fires no row or TRUNCATE triggers.
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.close();
    });

    it('is not ready when the active edition has the pinned label but other content', async () => {
      expect(impostor.contentSha256).not.toBe(PIN.contentSha256);
      expect(
        await checkReadiness({ connectionString: scopedUrl }, shippedMigrationNames(), PIN),
      ).toStrictEqual({
        report: { status: 'unavailable', database: 'up', migrations: 'current', corpus: 'missing' },
        failure: 'CorpusMissing',
      });
      const app = await appFor(PIN);
      try {
        const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
        expect(res.body).toStrictEqual({
          status: 'unavailable',
          database: 'up',
          migrations: 'current',
          corpus: 'missing',
        });
      } finally {
        await app.close();
      }
      // The same rows answer ready under their own content checksum.
      expect(
        await checkReadiness({ connectionString: scopedUrl }, shippedMigrationNames(), impostor),
      ).toStrictEqual({ report: READY });
    });

    it('reports a corpus altered behind disabled triggers as corrupt after a restart', async () => {
      const before = await appFor(tampered);
      try {
        expect(
          (await request(before.getHttpServer()).get('/v1/health').expect(200)).body,
        ).toStrictEqual(READY);

        // The table owner can bypass immutability: disable the trigger and alter a verse.
        await admin.transaction(async (transaction) => {
          await admin.query(
            `ALTER TABLE ${SCHEMA}.bible_verse DISABLE TRIGGER bible_verse_refuse_change`,
            { transaction },
          );
          await admin.query(
            `UPDATE ${SCHEMA}.bible_verse SET text = 'q'
             WHERE verse = 2 AND edition_id =
               (SELECT id FROM ${SCHEMA}.bible_edition WHERE code = 'tampertest')`,
            { transaction },
          );
          await admin.query(
            `ALTER TABLE ${SCHEMA}.bible_verse ENABLE TRIGGER bible_verse_refuse_change`,
            { transaction },
          );
        });

        // The running process verified at startup and does not re-hash on every probe.
        await sleep(READINESS_CACHE_MS + 100);
        expect(
          (await request(before.getHttpServer()).get('/v1/health').expect(200)).body,
        ).toStrictEqual(READY);
        expect(
          await checkReadiness({ connectionString: scopedUrl }, shippedMigrationNames(), tampered),
          'the cheap per-probe check only compares the stored checksum',
        ).toStrictEqual({ report: READY });
      } finally {
        await before.close();
      }

      // Restart: the startup integrity check re-hashes the stored rows.
      const after = await appFor(tampered);
      try {
        const res = await request(after.getHttpServer()).get('/v1/health').expect(503);
        expect(res.body).toStrictEqual({
          status: 'unavailable',
          database: 'up',
          migrations: 'current',
          corpus: 'corrupt',
        });
        // It stays corrupt for the life of the process, past the probe cache.
        await sleep(READINESS_CACHE_MS + 100);
        expect(
          (await request(after.getHttpServer()).get('/v1/health').expect(503)).body,
        ).toStrictEqual(res.body);
      } finally {
        await after.close();
      }
      expect(
        await checkReadiness(
          { connectionString: scopedUrl },
          shippedMigrationNames(),
          tampered,
          undefined,
          { verifyContent: true },
        ),
      ).toStrictEqual({
        report: { status: 'unavailable', database: 'up', migrations: 'current', corpus: 'corrupt' },
        failure: 'CorpusCorrupt',
      });
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
          await checkReadiness(
            { connectionString: empty.toString() },
            shippedMigrationNames(),
            PIN,
          ),
        ).toStrictEqual({
          report: {
            status: 'unavailable',
            database: 'up',
            migrations: 'pending',
            corpus: 'unknown',
          },
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
        await checkReadiness({ connectionString: url }, shippedMigrationNames().slice(0, 1), PIN),
      ).toStrictEqual({ report: READY });
    });

    it('reports a pinned corpus release that is not active as missing', async () => {
      expect(
        await checkReadiness({ connectionString: url }, shippedMigrationNames(), NOT_IMPORTED),
      ).toStrictEqual({
        report: { status: 'unavailable', database: 'up', migrations: 'current', corpus: 'missing' },
        failure: 'CorpusMissing',
      });
    });

    it('reports a refused connection by class and code only', async () => {
      expect(
        await checkReadiness({ connectionString: 'postgres://ba:secret@127.0.0.1:1/x' }, [], PIN),
      ).toStrictEqual({ report: DB_DOWN, failure: 'Error', code: 'ECONNREFUSED' });
    });
  });
});
