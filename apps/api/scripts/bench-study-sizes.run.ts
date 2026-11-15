/**
 * Study-size benchmark (BIB-52; NFR-PERF-001..005, NFR-SCALE-001/002; PRD section 31
 * "Performance fixtures: 20/100/500 nodes, up to 1,500 edges, and 10,000 events with varied note
 * sizes ... Test 2,000-node safety boundary").
 *
 * Run from the repo root against the database in `.env` `DATABASE_URL` (migrated, with the WEB
 * corpus imported):
 *
 *   pnpm --filter @bible-artisan/api bench:sizes
 *
 * It boots the real AppModule on a loopback port, signs in one throwaway user, and seeds through
 * the public API (so every write takes the normal mutation pipeline): studies with 20, 100 and
 * 500 nodes, 1,500 edges in the 500-node study, 100 studies on the account, and one study filled
 * to the 2,000-node cap. The 500-node study's Study Thread is then topped up to 10,000 events by
 * copying its own API-written events in SQL (writing 10,000 events through the API would only
 * measure the same mutation path again). Then it times the main reads (sequential p50/p95/max,
 * plus one burst of 100 concurrent requests) and prints a JSON report; with `BENCH_OUT=<path>`
 * it also writes the report there. The user and everything it owns are deleted at the end.
 *
 * It measures server latency over loopback HTTP only. Browser rendering, FPS and main-thread
 * blocking need a real browser and are not measured here.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { AccountStorageService } from '../src/modules/study/account-storage.service';
import { createTestApp } from '../test/app';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 50);
const CONCURRENCY = 100;

interface Stat {
  name: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** A parsed JSON response body. */
type Body = Record<string, unknown>;

/** One field of a JSON body, by path (`a.b.0.c`), as a string; throws when missing. */
function field(body: unknown, path: string): string {
  let value: unknown = body;
  for (const key of path.split('.')) value = (value as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string') throw new Error(`missing ${path}`);
  return value;
}

function num(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== 'number') throw new Error(`missing ${key}`);
  return value;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

function stat(name: string, samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    name,
    n: sorted.length,
    p50: round(at(0.5) ?? 0),
    p95: round(at(0.95) ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

it('benchmarks the supported study sizes', { timeout: 60 * 60 * 1000 }, async () => {
  const app: INestApplication<Server> = await createTestApp();
  const db = app.get<Database>(DATABASE);
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/v1`;
  const user = await User.create({ normalizedEmail: `bench-${randomUUID()}@example.test` });
  const { token } = await db.transaction((transaction) =>
    app.get(SessionService).create(user.id, transaction),
  );
  const cookie = `ba_session=${token}`;
  const stats: Stat[] = [];
  const writeTimes: Record<string, number[]> = {};

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Body; ms: number }> {
    const started = performance.now();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    const ms = performance.now() - started;
    return { status: res.status, body: (raw ? JSON.parse(raw) : {}) as Body, ms };
  }

  async function mutate(
    kind: string,
    method: string,
    path: string,
    body: unknown,
    ok: number[],
  ): Promise<Body> {
    const res = await call(method, path, body);
    if (!ok.includes(res.status)) {
      throw new Error(`${kind} ${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    (writeTimes[kind] ??= []).push(res.ms);
    return res.body;
  }

  async function read(path: string): Promise<number> {
    const res = await call('GET', path);
    if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status}`);
    return res.ms;
  }

  async function timeReads(name: string, path: () => string, n = ITERATIONS): Promise<void> {
    for (let i = 0; i < 3; i += 1) await read(path()); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < n; i += 1) samples.push(await read(path()));
    stats.push(stat(name, samples));
  }

  async function timeBurst(name: string, path: string): Promise<void> {
    const samples = await Promise.all(Array.from({ length: CONCURRENCY }, () => read(path)));
    stats.push(stat(`${name} (${CONCURRENCY} concurrent)`, samples));
  }

  /** What the study page loads in parallel before it shows content (server side only). */
  async function timeWorkspace(name: string, studyId: string): Promise<void> {
    const paths = [
      `/studies/${studyId}`,
      `/studies/${studyId}/graph`,
      `/studies/${studyId}/nodes`,
      `/studies/${studyId}/notes`,
      `/studies/${studyId}/events?limit=50`,
      `/studies/${studyId}/limits`,
    ];
    const samples: number[] = [];
    for (let i = 0; i < 3 + ITERATIONS; i += 1) {
      const started = performance.now();
      await Promise.all(paths.map((path) => read(path)));
      if (i >= 3) samples.push(performance.now() - started);
    }
    stats.push(stat(name, samples));
  }

  let revision = new Map<string, number>();

  async function createStudy(title: string): Promise<string> {
    const body = await mutate('POST /studies', 'POST', '/studies', { title, blank: true }, [201]);
    const studyId = field(body, 'studyId');
    revision.set(studyId, num(body, 'revision'));
    return studyId;
  }

  /** Text nodes with varied sizes (60 to ~6,000 characters), mostly observations. */
  async function addNodes(studyId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const size = [60, 400, 1500, 6000][i % 4] ?? 60;
      const text =
        `Observation ${i}: ${'conscience bears witness '.repeat(Math.ceil(size / 25))}`.slice(
          0,
          size,
        );
      const node =
        i % 10 === 0
          ? { type: 'question', text: `Question ${i}: what does this passage teach?` }
          : i % 10 === 1
            ? { type: 'thought', text }
            : { type: 'observation', text, observationKind: 'textual_observation' };
      const body = await mutate(
        'POST /nodes',
        'POST',
        `/studies/${studyId}/nodes`,
        { expectedRevision: revision.get(studyId), ...node },
        [201],
      );
      revision.set(studyId, num(body, 'studyRevision'));
      ids.push(field(body, 'id'));
    }
    return ids;
  }

  /** `count` distinct edges: node i to node i+k for k = 1, 2, 3, … (no self-edges). */
  async function addEdges(studyId: string, nodes: string[], count: number): Promise<void> {
    const types = ['related_to', 'explains', 'references'];
    for (let i = 0; i < count; i += 1) {
      const k = 1 + Math.floor(i / nodes.length);
      const from = i % nodes.length;
      const body = await mutate(
        'POST /edges',
        'POST',
        `/studies/${studyId}/edges`,
        {
          expectedRevision: revision.get(studyId),
          sourceNodeId: nodes[from],
          targetNodeId: nodes[(from + k) % nodes.length],
          type: types[(k - 1) % types.length],
        },
        [201],
      );
      revision.set(studyId, num(body, 'studyRevision'));
    }
  }

  /** Copies the study's own API-written events until it holds `target` events. */
  async function fillEvents(studyId: string, target: number): Promise<void> {
    await db.query(
      `WITH base AS (
         SELECT row_number() OVER (ORDER BY sequence) AS rn, event_type, payload_json, visibility,
                actor_kind, node_id, from_node_id, branch_id, version_id
           FROM study_event
          WHERE study_id = $1 AND owner_id = $2 AND session_id IS NULL
       ), last AS (
         SELECT last_event_sequence AS l FROM study WHERE id = $1 AND owner_id = $2
       ), cnt AS (SELECT count(*) AS c FROM base)
       INSERT INTO study_event (study_id, owner_id, sequence, event_type, payload_json, visibility,
                                actor_kind, node_id, from_node_id, branch_id, version_id)
       SELECT $1, $2, last.l + g, b.event_type, b.payload_json, b.visibility, b.actor_kind,
              b.node_id, b.from_node_id, b.branch_id, b.version_id
         FROM last CROSS JOIN cnt CROSS JOIN generate_series(1, $3 - last.l) AS g
         JOIN base b ON b.rn = ((g - 1) % cnt.c) + 1`,
      { bind: [studyId, user.id, target] },
    );
    await db.query(
      `UPDATE study SET last_event_sequence =
         (SELECT max(sequence) FROM study_event WHERE study_id = $1) WHERE id = $1 AND owner_id = $2`,
      { bind: [studyId, user.id] },
    );
  }

  const seedStarted = performance.now();
  try {
    const s20 = await createStudy('Bench 20');
    const n20 = await addNodes(s20, 20);
    await addEdges(s20, n20, 20);
    const s100 = await createStudy('Bench 100');
    const n100 = await addNodes(s100, 100);
    await addEdges(s100, n100, 200);
    const s500 = await createStudy('Bench 500');
    const n500 = await addNodes(s500, 500);
    await addEdges(s500, n500, 1500);
    await fillEvents(s500, 10_000);
    const s2000 = await createStudy('Bench 2000 cap');
    await addNodes(s2000, 2000);
    for (let i = 4; i < 100; i += 1) await createStudy(`Bench library ${i}`);
    const seedSeconds = round((performance.now() - seedStarted) / 1000);

    // The 2,000-node boundary: the next node is refused, reads still work.
    const over = await call('POST', `/studies/${s2000}/nodes`, {
      expectedRevision: revision.get(s2000),
      type: 'question',
      text: 'One too many?',
    });
    const capLimits = await call('GET', `/studies/${s2000}/limits`);

    const editions = await call('GET', '/bible/translations');
    const editionId = field(editions.body, 'translations.0.id');
    const resolved = await call('POST', '/bible/resolve', { input: 'Romans 9', editionId });
    const romans9 = field(resolved.body, 'reference.id');

    for (const [label, studyId] of [
      ['20 nodes', s20],
      ['100 nodes', s100],
      ['500 nodes / 1,500 edges / 10,000 events', s500],
      ['2,000 nodes (cap)', s2000],
    ] as const) {
      await timeWorkspace(`workspace bundle, ${label}`, studyId);
      await timeReads(`GET /graph, ${label}`, () => `/studies/${studyId}/graph`);
      await timeReads(`GET /nodes, ${label}`, () => `/studies/${studyId}/nodes`);
      await timeReads(`GET /limits, ${label}`, () => `/studies/${studyId}/limits`);
    }
    await timeReads('GET /studies/:id, 500 nodes', () => `/studies/${s500}`);
    await timeReads(
      'GET /events first page (50), 10,000 events',
      () => `/studies/${s500}/events?limit=50`,
    );

    // Every page of the 10,000-event thread, newest first, following the cursors.
    const pageTimes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await call(
        'GET',
        `/studies/${s500}/events?limit=50&includeInternal=true${query}`,
      );
      if (res.status !== 200) throw new Error(`events page -> ${res.status}`);
      pageTimes.push(res.ms);
      cursor = typeof res.body.nextCursor === 'string' ? res.body.nextCursor : null;
      pages += 1;
    } while (cursor);
    stats.push(stat(`GET /events every page (${pages} pages of 50), 10,000 events`, pageTimes));

    await timeReads('GET /studies library (50), 100 studies', () => '/studies?limit=50');
    await timeReads('GET /resume, 500 nodes', () => `/studies/${s500}/resume`);
    await timeReads('GET /bible/passages Romans 9', () => `/bible/passages?referenceId=${romans9}`);
    const words = ['love', 'faith', 'conscience', 'grace', 'light', 'truth', 'spirit', 'law'];
    let w = 0;
    await timeReads('GET /bible/search terms', () => {
      w += 1;
      return `/bible/search?q=${words[w % words.length]}&editionId=${editionId}&limit=25`;
    });
    await timeReads('GET /bible/search phrase', () => {
      w += 1;
      return `/bible/search?q=${encodeURIComponent(['the love of god', 'in the beginning', 'grace and peace', 'holy spirit'][w % 4] ?? '')}&mode=phrase&editionId=${editionId}&limit=25`;
    });

    await timeBurst('GET /events first page, 10,000 events', `/studies/${s500}/events?limit=50`);
    await timeBurst('GET /graph, 500 nodes', `/studies/${s500}/graph`);
    await timeBurst(
      'GET /bible/search terms',
      `/bible/search?q=love&editionId=${editionId}&limit=25`,
    );

    const storage = app.get(AccountStorageService);
    const measureTimes: number[] = [];
    let storageBytes = 0;
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      storageBytes = await storage.measure(user.id);
      measureTimes.push(performance.now() - started);
    }
    stats.push(stat('account storage measurement, 100 studies', measureTimes));

    for (const [kind, samples] of Object.entries(writeTimes)) {
      stats.push(stat(`${kind} (during seeding)`, samples));
    }

    const [pg] = await db.query<{ server_version: string }>('SHOW server_version', {
      type: QueryTypes.SELECT,
    });
    const report = {
      measuredAt: new Date().toISOString(),
      environment: {
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        os: `${platform()} ${release()}`,
        node: process.version,
        postgres: pg?.server_version,
        transport: 'loopback HTTP, one API process, client in the same process',
        iterations: ITERATIONS,
      },
      fixtures: {
        studies: 100,
        seedSeconds,
        eventsIn500NodeStudy: 10_000,
        accountStorageBytes: storageBytes,
      },
      capBoundary: {
        node2001Status: over.status,
        node2001Code: over.body.code,
        limitsAtCap: capLimits.body.nodes,
      },
      stats,
    };
    write(JSON.stringify(report, null, 2));
    if (process.env.BENCH_OUT)
      writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
  } finally {
    await User.destroy({ where: { id: user.id } });
    revision = new Map();
    await app.close();
  }
});
