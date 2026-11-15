import { describe, expect, it } from 'vitest';
import type { AiOperationalStats } from '../ai/ai-operations.service';
import {
  evaluateAlerts,
  isSave,
  latencyTargetMs,
  type OperationalSnapshot,
  quantileUpperBoundMs,
  type RouteWindow,
  summarize,
} from './alert-rules';

const QUIET_AI: AiOperationalStats = {
  queuedJobs: 0,
  runningJobs: 0,
  oldestEligibleJobSeconds: 0,
  finishedJobs: 0,
  succeededJobs: 0,
  invalidOutputJobs: 0,
  providerFailedJobs: 0,
  windowInputTokens: 0,
  windowOutputTokens: 0,
  windowCostMicros: 0,
  monthSpendMicros: 0,
  monthSpendCapMicros: 50_000_000,
};

/** A route window with `requests` fast (≤25 ms) successes unless overridden. */
function route(method: string, path: string, over: Partial<RouteWindow> = {}): RouteWindow {
  const requests = over.requests ?? 100;
  return {
    method,
    route: path,
    requests,
    serverErrors: 0,
    conflicts: 0,
    unauthorized: 0,
    forbidden: 0,
    notFound: 0,
    aborted: 0,
    latencyHistogram: [requests, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...over,
  };
}

function snapshot(over: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return {
    routes: [],
    ai: QUIET_AI,
    database: { connections: 5, maxConnections: 100 },
    ...over,
  };
}

const names = (s: OperationalSnapshot): string[] => evaluateAlerts(s).map((a) => a.alert);

describe('route classification', () => {
  it('treats study writes as saves, but not reads, exports or other areas', () => {
    expect(isSave('PATCH', '/v1/studies/:studyId/nodes/:nodeId')).toBe(true);
    expect(isSave('POST', '/v1/studies')).toBe(true);
    expect(isSave('GET', '/v1/studies/:studyId')).toBe(false);
    expect(isSave('POST', '/v1/studies/:studyId/exports')).toBe(false);
    expect(isSave('POST', '/v1/auth/otp/verify')).toBe(false);
  });

  it('uses the section 22 targets and excludes probes, sign-in, exports and unmatched', () => {
    expect(latencyTargetMs('/v1/studies/:studyId/graph')).toBe(500);
    expect(latencyTargetMs('/v1/bible/search')).toBe(750);
    for (const excluded of [
      'unmatched',
      '/v1/health',
      '/v1/health/live',
      '/v1/openapi.json',
      '/v1/auth/otp/start',
      '/v1/me/exports',
      '/v1/exports/:exportId/download',
    ]) {
      expect(latencyTargetMs(excluded)).toBeNull();
    }
  });
});

describe('evaluateAlerts', () => {
  it('fires nothing for a healthy snapshot', () => {
    const s = snapshot({
      routes: [route('PATCH', '/v1/studies/:studyId'), route('GET', '/v1/me')],
    });
    expect(evaluateAlerts(s)).toStrictEqual([]);
  });

  it('fires save_error_rate above 1% of saves over the window, with opaque context only', () => {
    const failing = snapshot({
      routes: [
        route('PATCH', '/v1/studies/:studyId/notes/:noteId', { requests: 150, serverErrors: 1 }),
        route('POST', '/v1/studies/:studyId/nodes', { requests: 50, serverErrors: 2 }),
        // Reads failing do not count as save failures.
        route('GET', '/v1/studies/:studyId', { requests: 1000, serverErrors: 0 }),
      ],
    });
    expect(evaluateAlerts(failing)).toStrictEqual([
      {
        alert: 'save_error_rate',
        key: 'save_error_rate',
        severity: 'critical',
        value: 0.015,
        threshold: 0.01,
        windowMinutes: 15,
        sampleSize: 200,
      },
    ]);
  });

  it('does not fire save_error_rate at exactly 1%, or below the minimum sample', () => {
    expect(
      names(snapshot({ routes: [route('PATCH', '/v1/studies/:studyId', { serverErrors: 1 })] })),
    ).toStrictEqual([]);
    expect(
      names(
        snapshot({
          routes: [route('PATCH', '/v1/studies/:studyId', { requests: 19, serverErrors: 5 })],
        }),
      ),
    ).not.toContain('save_error_rate');
  });

  it('fires api_error_rate above 5% of all requests', () => {
    expect(
      names(snapshot({ routes: [route('GET', '/v1/studies/:studyId', { serverErrors: 6 })] })),
    ).toStrictEqual(['api_error_rate']);
  });

  it('fires latency_p95 per route when fewer than 95% of requests met the target', () => {
    const slow = route('GET', '/v1/studies/:studyId/graph', {
      requests: 100,
      // 94 within 500 ms, 6 between 500 and 750 ms.
      latencyHistogram: [90, 0, 0, 0, 4, 6, 0, 0, 0, 0, 0],
    });
    const search = route('GET', '/v1/bible/search', {
      requests: 100,
      // 95 within 750 ms: on target.
      latencyHistogram: [0, 0, 0, 0, 0, 95, 5, 0, 0, 0, 0],
    });
    expect(evaluateAlerts(snapshot({ routes: [slow, search] }))).toStrictEqual([
      {
        alert: 'latency_p95',
        key: 'latency_p95 GET /v1/studies/:studyId/graph',
        severity: 'warning',
        value: 750,
        threshold: 500,
        windowMinutes: 15,
        sampleSize: 100,
        method: 'GET',
        route: '/v1/studies/:studyId/graph',
      },
    ]);
  });

  it('does not fire latency_p95 for an excluded route or a quiet route', () => {
    const slowHist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30];
    expect(
      names(
        snapshot({
          routes: [
            route('POST', '/v1/auth/otp/verify', { requests: 30, latencyHistogram: slowHist }),
            route('GET', '/v1/me', {
              requests: 19,
              latencyHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19],
            }),
          ],
        }),
      ),
    ).toStrictEqual([]);
  });

  it('fires ai_queue_age when the oldest eligible job waited over five minutes', () => {
    expect(names(snapshot({ ai: { ...QUIET_AI, oldestEligibleJobSeconds: 300 } }))).toStrictEqual(
      [],
    );
    expect(
      evaluateAlerts(
        snapshot({ ai: { ...QUIET_AI, oldestEligibleJobSeconds: 301, queuedJobs: 2 } }),
      ),
    ).toStrictEqual([
      {
        alert: 'ai_queue_age',
        key: 'ai_queue_age',
        severity: 'critical',
        value: 301,
        threshold: 300,
        sampleSize: 2,
      },
    ]);
  });

  it('fires authorization_anomaly on many 403s and matched 404s, ignoring unknown paths', () => {
    const probing = snapshot({
      routes: [
        route('GET', '/v1/studies/:studyId', { requests: 200, notFound: 40 }),
        route('POST', 'unmatched', { requests: 100, forbidden: 10, notFound: 90 }),
      ],
    });
    expect(evaluateAlerts(probing)).toStrictEqual([
      {
        alert: 'authorization_anomaly',
        key: 'authorization_anomaly',
        severity: 'warning',
        value: 50,
        threshold: 50,
        windowMinutes: 15,
        sampleSize: 300,
      },
    ]);
    // The same denials spread over enough ordinary traffic stay under the 10% rate.
    expect(
      names(
        snapshot({
          routes: [route('GET', '/v1/studies/:studyId', { requests: 600, notFound: 50 })],
        }),
      ),
    ).toStrictEqual([]);
  });

  it('fires ai_spend_cap as a warning from 80% of the cap and critical at the cap', () => {
    const at = (spend: number): OperationalSnapshot =>
      snapshot({ ai: { ...QUIET_AI, monthSpendMicros: spend } });
    expect(names(at(39_999_999))).toStrictEqual([]);
    expect(evaluateAlerts(at(40_000_000))).toMatchObject([
      { alert: 'ai_spend_cap', severity: 'warning', value: 0.8, threshold: 0.8 },
    ]);
    expect(evaluateAlerts(at(50_000_000))).toMatchObject([
      { alert: 'ai_spend_cap', severity: 'critical', value: 1 },
    ]);
    expect(names(snapshot({ ai: { ...QUIET_AI, monthSpendCapMicros: 0 } }))).toStrictEqual([]);
  });

  it('fires export_failures on any failed export in the window', () => {
    expect(
      evaluateAlerts(
        snapshot({
          routes: [route('POST', '/v1/studies/:studyId/exports', { requests: 3, serverErrors: 1 })],
        }),
      ),
    ).toStrictEqual([
      {
        alert: 'export_failures',
        key: 'export_failures',
        severity: 'warning',
        value: 1,
        threshold: 1,
        windowMinutes: 15,
        sampleSize: 3,
      },
    ]);
  });

  it('fires ai_invalid_output and ai_provider_failures from five finished jobs', () => {
    const ai = { ...QUIET_AI, finishedJobs: 5, invalidOutputJobs: 1, providerFailedJobs: 3 };
    expect(names(snapshot({ ai }))).toStrictEqual(['ai_invalid_output', 'ai_provider_failures']);
    expect(names(snapshot({ ai: { ...ai, finishedJobs: 4 } }))).toStrictEqual([]);
  });

  it('fires database_saturation from 80% of max_connections', () => {
    expect(names(snapshot({ database: { connections: 79, maxConnections: 100 } }))).toStrictEqual(
      [],
    );
    expect(names(snapshot({ database: { connections: 80, maxConnections: 100 } }))).toStrictEqual([
      'database_saturation',
    ]);
  });
});

describe('summarize', () => {
  it('reports window totals and rates as numbers only', () => {
    const s = snapshot({
      routes: [
        route('PATCH', '/v1/studies/:studyId', { requests: 200, serverErrors: 1, conflicts: 4 }),
        route('GET', '/v1/me', { requests: 50, unauthorized: 10, aborted: 1 }),
        route('POST', '/v1/me/exports', { requests: 2, serverErrors: 1 }),
      ],
    });
    expect(summarize(s)).toStrictEqual({
      requests: 252,
      serverErrors: 2,
      serverErrorRate: 0.0079,
      saves: 200,
      saveFailures: 1,
      saveFailureRate: 0.005,
      saveConflicts: 4,
      saveConflictRate: 0.02,
      exportRequests: 2,
      exportFailures: 1,
      unauthorized: 10,
      authorizationDenials: 0,
      abortedRequests: 1,
      routesOverLatencyTarget: 0,
      aiQueuedJobs: 0,
      aiRunningJobs: 0,
      aiOldestEligibleJobSeconds: 0,
      aiFinishedJobs: 0,
      aiInvalidOutputJobs: 0,
      aiProviderFailedJobs: 0,
      aiInputTokens: 0,
      aiOutputTokens: 0,
      aiWindowCostMicros: 0,
      aiMonthSpendMicros: 0,
      aiMonthSpendCapMicros: 50_000_000,
      databaseConnections: 5,
      databaseMaxConnections: 100,
    });
  });

  it('reports a quantile as its slot bound, the slowest bound for overflow, null when empty', () => {
    expect(quantileUpperBoundMs([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.95)).toBeNull();
    expect(quantileUpperBoundMs([95, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.95)).toBe(25);
    expect(quantileUpperBoundMs([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.95)).toBe(10_000);
  });
});
