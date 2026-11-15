import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AiJob } from '../src/database/models/ai-job.model';
import { OperationalRequestMetric } from '../src/database/models/operational-request-metric.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { AI_RUNTIME, type AiRuntime } from '../src/modules/ai/provider/ai-provider';
import { createAppLogger } from '../src/modules/observability/logger';
import { OperationalAlertsService } from '../src/modules/observability/operational-alerts.service';
import { RequestMetricsFlusher } from '../src/modules/observability/request-metrics-flusher.service';
import {
  type ObservedRequest,
  RequestMetricsRecorder,
} from '../src/modules/observability/request-metrics';
import { WorkerModule } from '../src/worker.module';

type LogEntry = Record<string, unknown>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Every key an `ops_metrics` / `ops_alert` line may carry: the logger's own plus the allowlist. */
const OPS_KEYS = new Set([
  'level',
  'pid',
  'timestamp',
  'message',
  'context',
  'state',
  'alert',
  'severity',
  'value',
  'threshold',
  'windowMinutes',
  'aiWindowMinutes',
  'sampleSize',
  'method',
  'route',
  'firingSeconds',
  'requests',
  'serverErrors',
  'serverErrorRate',
  'saves',
  'saveFailures',
  'saveFailureRate',
  'saveConflicts',
  'saveConflictRate',
  'exportRequests',
  'exportFailures',
  'unauthorized',
  'authorizationDenials',
  'abortedRequests',
  'routesOverLatencyTarget',
  'aiQueuedJobs',
  'aiRunningJobs',
  'aiOldestEligibleJobSeconds',
  'aiFinishedJobs',
  'aiInvalidOutputJobs',
  'aiProviderFailedJobs',
  'aiInputTokens',
  'aiOutputTokens',
  'aiWindowCostMicros',
  'aiMonthSpendMicros',
  'aiMonthSpendCapMicros',
  'databaseConnections',
  'databaseMaxConnections',
]);

/**
 * BIB-50 synthetic alert tests (PRD section 30). Two in-memory recorders stand in for two API
 * processes and flush into the real `operational_request_metric`; AI jobs are real `ai_job` rows.
 * Everything is dated in a far-past minute nobody else writes, and the real worker evaluator
 * (`OperationalAlertsService`, resolved from `WorkerModule`) evaluates "as of" that minute, so
 * traffic from other suites cannot leak into the window. Logs go through the PRODUCTION logger
 * and are captured, so the test proves both that the alert fires and what its line contains.
 */
describe('operational alerts (BIB-50)', () => {
  let moduleRef: TestingModule;
  let db: Database;
  let alerts: OperationalAlertsService;
  let runtime: AiRuntime;
  const captured: string[] = [];
  const spies: MockInstance[] = [];
  const userIds: string[] = [];
  /** A random minute of 2001, so reruns (and a crashed earlier run) never share a window. */
  const t0 = Date.UTC(2001, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27));
  /** Opaque values that must never appear in an operational line. */
  const sentinels: string[] = [];

  function entries(): LogEntry[] {
    return captured
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogEntry);
  }

  const opsLines = (): LogEntry[] =>
    entries().filter((entry) => entry.message === 'ops_alert' || entry.message === 'ops_metrics');

  function record(recorder: RequestMetricsRecorder, request: ObservedRequest, times: number): void {
    for (let i = 0; i < times; i += 1) recorder.record(request);
  }

  beforeAll(async () => {
    const capture = (chunk: unknown): boolean => {
      captured.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString(),
      );
      return true;
    };
    spies.push(
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
    );
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    moduleRef.useLogger(createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'verbose' }));
    db = moduleRef.get<Database>(DATABASE);
    alerts = moduleRef.get(OperationalAlertsService);
    runtime = moduleRef.get<AiRuntime>(AI_RUNTIME);
  });

  afterAll(async () => {
    await OperationalRequestMetric.destroy({
      where: { bucketStart: { [Op.gte]: new Date(t0 - DAY), [Op.lt]: new Date(t0 + DAY) } },
    });
    await User.destroy({ where: { id: userIds } });
    await moduleRef.close();
    for (const spy of spies) spy.mockRestore();
  });

  it('sums the counts that several API processes flush for the same minute and route', async () => {
    const route = `/v1/flush-test/${randomUUID()}`;
    const processA = new RequestMetricsRecorder(() => t0 - 30 * MINUTE + 1_000);
    const processB = new RequestMetricsRecorder(() => t0 - 30 * MINUTE + 59_000);
    record(processA, { method: 'PATCH', route, status: 200, durationMs: 10, aborted: false }, 3);
    record(processA, { method: 'PATCH', route, status: 409, durationMs: 600, aborted: false }, 1);
    record(
      processB,
      { method: 'PATCH', route, status: 503, durationMs: 20_000, aborted: false },
      2,
    );
    record(processB, { method: 'PATCH', route, status: null, durationMs: 5, aborted: true }, 1);

    expect(await new RequestMetricsFlusher(db, processA).flush()).toBe(1);
    expect(await new RequestMetricsFlusher(db, processB).flush()).toBe(1);
    // Nothing pending: a second flush writes nothing.
    expect(await new RequestMetricsFlusher(db, processB).flush()).toBe(0);

    const rows = await OperationalRequestMetric.findAll({ where: { route }, raw: true });
    expect(rows).toStrictEqual([
      {
        bucketStart: new Date(t0 - 30 * MINUTE),
        method: 'PATCH',
        route,
        requestCount: 7,
        serverErrorCount: 2,
        conflictCount: 1,
        unauthorizedCount: 0,
        forbiddenCount: 0,
        notFoundCount: 0,
        abortedCount: 1,
        latencyHistogram: [4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2],
      },
    ]);
    await OperationalRequestMetric.destroy({ where: { route } });
  });

  it('fires the section 30 alerts with opaque context, then resolves them when the window clears', async () => {
    // Synthetic API traffic in the minute before t0, from two "processes".
    const a = new RequestMetricsRecorder(() => t0 - MINUTE);
    const b = new RequestMetricsRecorder(() => t0 - MINUTE);
    const ok = { status: 200, durationMs: 10, aborted: false };
    const notes = { method: 'PATCH', route: '/v1/studies/:studyId/notes/:noteId' };
    // 200 saves, 4 failed: 2% > 1%.
    record(a, { ...notes, ...ok }, 150);
    record(b, { ...notes, ...ok }, 46);
    record(b, { ...notes, status: 503, durationMs: 10, aborted: false }, 4);
    // 40 graph reads at ~800 ms: p95 over the 500 ms target.
    record(a, { method: 'GET', route: '/v1/studies/:studyId/graph', ...ok, durationMs: 800 }, 40);
    // One failed export.
    record(a, { method: 'POST', route: '/v1/studies/:studyId/exports', ...ok, status: 500 }, 1);
    // 60 owner-scope refusals (404) out of 301 requests.
    record(b, { method: 'GET', route: '/v1/studies/:studyId', ...ok, status: 404 }, 60);
    await new RequestMetricsFlusher(db, a).flush();
    await new RequestMetricsFlusher(db, b).flush();

    // AI: five jobs finished ten minutes before t0 (two invalid outputs, three provider
    // failures) costing 90% of the monthly cap, and one job eligible for 20 minutes.
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const title = `SENTINEL-title-${randomUUID()}`;
    const study = await Study.create({ ownerId: user.id, title });
    sentinels.push(user.id, user.normalizedEmail, study.id, title);
    const costEach = Math.floor((runtime.monthlySpendCapMicros * 0.9) / 5);
    const finishedAt = new Date(t0 - 10 * MINUTE);
    const job = (state: AiJob['state'], extra: Partial<AiJob> = {}): Promise<AiJob> =>
      AiJob.create({
        ownerId: user.id,
        studyId: study.id,
        capability: 'summary',
        requestKey: `ops-test:${randomUUID()}`,
        basisRevision: 1,
        consentVersion: 'v1',
        state,
        createdAt: new Date(t0 - 20 * MINUTE),
        availableAt: new Date(t0 - 20 * MINUTE),
        ...extra,
      });
    const jobs = await Promise.all([
      ...[1, 2].map(() =>
        job('failed', { errorCode: 'VALIDATION_FAILED', finishedAt, costMicros: String(costEach) }),
      ),
      ...[1, 2, 3].map(() =>
        job('failed', { errorCode: 'PROVIDER_ERROR', finishedAt, costMicros: String(costEach) }),
      ),
      job('queued'),
    ]);
    sentinels.push(...jobs.map((j) => j.id));

    const at = new Date(t0);
    const first = await alerts.evaluate(at);
    expect(first.firing.map((alert) => alert.alert).sort()).toStrictEqual([
      'ai_invalid_output',
      'ai_provider_failures',
      'ai_queue_age',
      'ai_spend_cap',
      'authorization_anomaly',
      'export_failures',
      'latency_p95',
      'save_error_rate',
    ]);
    expect(first.firing.find((alert) => alert.alert === 'save_error_rate')).toStrictEqual({
      alert: 'save_error_rate',
      key: 'save_error_rate',
      severity: 'critical',
      value: 0.02,
      threshold: 0.01,
      windowMinutes: 15,
      sampleSize: 200,
    });
    expect(first.firing.find((alert) => alert.alert === 'latency_p95')).toStrictEqual({
      alert: 'latency_p95',
      key: 'latency_p95 GET /v1/studies/:studyId/graph',
      severity: 'warning',
      value: 1000,
      threshold: 500,
      windowMinutes: 15,
      sampleSize: 40,
      method: 'GET',
      route: '/v1/studies/:studyId/graph',
    });
    expect(first.firing.find((alert) => alert.alert === 'ai_queue_age')).toMatchObject({
      severity: 'critical',
      value: 1200,
      threshold: 300,
    });
    expect(first.metrics).toStrictEqual({
      requests: 301,
      serverErrors: 5,
      serverErrorRate: 0.0166,
      saves: 200,
      saveFailures: 4,
      saveFailureRate: 0.02,
      saveConflicts: 0,
      saveConflictRate: 0,
      exportRequests: 1,
      exportFailures: 1,
      unauthorized: 0,
      authorizationDenials: 60,
      abortedRequests: 0,
      routesOverLatencyTarget: 1,
      aiQueuedJobs: expect.any(Number),
      aiRunningJobs: expect.any(Number),
      aiOldestEligibleJobSeconds: 1200,
      aiFinishedJobs: 5,
      aiInvalidOutputJobs: 2,
      aiProviderFailedJobs: 3,
      aiInputTokens: 0,
      aiOutputTokens: 0,
      aiWindowCostMicros: costEach * 5,
      aiMonthSpendMicros: costEach * 5,
      aiMonthSpendCapMicros: runtime.monthlySpendCapMicros,
      databaseConnections: expect.any(Number),
      databaseMaxConnections: expect.any(Number),
    });

    // One structured line per firing alert; critical ones at error level.
    const firingLines = opsLines().filter((e) => e.message === 'ops_alert' && e.state === 'firing');
    expect(firingLines).toHaveLength(8);
    expect(firingLines.find((e) => e.alert === 'save_error_rate')).toStrictEqual({
      level: 'error',
      pid: expect.any(Number),
      timestamp: expect.any(Number),
      message: 'ops_alert',
      context: 'OpsAlerts',
      state: 'firing',
      alert: 'save_error_rate',
      severity: 'critical',
      value: 0.02,
      threshold: 0.01,
      windowMinutes: 15,
      sampleSize: 200,
      firingSeconds: 0,
    });
    expect(firingLines.find((e) => e.alert === 'export_failures')?.level).toBe('warn');

    // Two hours later the HTTP and AI windows are empty: those alerts resolve. The spend (same
    // month) and the still-waiting job keep firing, now with a firing duration.
    const later = await alerts.evaluate(new Date(t0 + 120 * MINUTE));
    expect(later.firing.map((alert) => alert.alert).sort()).toStrictEqual([
      'ai_queue_age',
      'ai_spend_cap',
    ]);
    expect(later.resolved.map((alert) => alert.alert).sort()).toStrictEqual([
      'ai_invalid_output',
      'ai_provider_failures',
      'authorization_anomaly',
      'export_failures',
      'latency_p95',
      'save_error_rate',
    ]);
    const resolvedLines = opsLines().filter(
      (e) => e.message === 'ops_alert' && e.state === 'resolved',
    );
    expect(resolvedLines.find((e) => e.alert === 'save_error_rate')).toMatchObject({
      level: 'log',
      state: 'resolved',
      firingSeconds: 7200,
    });
    expect(
      opsLines()
        .filter((e) => e.state === 'firing' && e.alert === 'ai_queue_age')
        .at(-1),
    ).toMatchObject({ value: 8400, firingSeconds: 7200 });
  });

  it('writes only allowlisted, content-free operational lines', () => {
    const lines = opsLines();
    expect(lines.filter((e) => e.message === 'ops_metrics').length).toBeGreaterThanOrEqual(2);
    for (const entry of lines) {
      expect(Object.keys(entry).filter((key) => !OPS_KEYS.has(key))).toStrictEqual([]);
    }
    const output = captured.join('').toLowerCase();
    expect(sentinels.filter((value) => output.includes(value.toLowerCase()))).toStrictEqual([]);
  });

  it('deletes request metrics past the 30-day retention', async () => {
    const route = `/v1/retention-test/${randomUUID()}`;
    const recorder = new RequestMetricsRecorder(() => t0);
    recorder.record({ method: 'GET', route, status: 200, durationMs: 1, aborted: false });
    await new RequestMetricsFlusher(db, recorder).flush();
    const recent = new RequestMetricsRecorder(() => Date.now());
    recent.record({ method: 'GET', route, status: 200, durationMs: 1, aborted: false });
    await new RequestMetricsFlusher(db, recent).flush();

    expect(await alerts.purgeExpired()).toBeGreaterThanOrEqual(1);
    const left = await OperationalRequestMetric.findAll({ where: { route }, raw: true });
    expect(left.map((row) => row.bucketStart.getTime() > t0)).toStrictEqual([true]);
    await OperationalRequestMetric.destroy({ where: { route } });
  });
});
