import type { AiOperationalStats } from '../ai/ai-operations.service';
import { REQUEST_LATENCY_BOUNDS_MS } from './request-metrics';

/**
 * Operational alert rules (BIB-50, PRD section 30). Pure functions over a content-free snapshot,
 * so every threshold is unit-tested with synthetic numbers.
 *
 * Section 30 sets: save error > 1% over 15 minutes, p95 latency over target for 15 minutes
 * (section 22: 500 ms for reads and mutations, 750 ms for search), oldest eligible job > five
 * minutes, authorization anomalies, and approaching the spend cap. The remaining thresholds
 * (API 5xx rate, export failures, AI invalid output and provider failures, database connection
 * saturation) are not numbers in the PRD; the values below are this ticket's defaults, chosen to
 * fire on a real incident rather than one stray request, and documented in
 * `docs/operations/alerting.md`.
 */
export const ALERT_THRESHOLDS = {
  /** The request window every HTTP rule reads ("sustained … over 15 minutes"). */
  requestWindowMinutes: 15,
  /** AI jobs are low volume, so their rates use an hour. */
  aiWindowMinutes: 60,
  /** Fewer requests than this in a window cannot fire a rate or latency rule (noise floor). */
  minRequests: 20,
  saveFailureRate: 0.01,
  apiServerErrorRate: 0.05,
  latencyQuantile: 0.95,
  oldestEligibleJobSeconds: 5 * 60,
  /** 403s plus 404s on matched routes (cross-owner probes answer 404, NFR-SEC-001). */
  authorizationDenials: 50,
  authorizationDenialRate: 0.1,
  spendCapWarningRatio: 0.8,
  exportFailures: 1,
  minAiJobs: 5,
  aiInvalidOutputRate: 0.2,
  aiProviderFailureRate: 0.5,
  databaseConnectionRatio: 0.8,
} as const;

/** One route's counters summed over the request window. */
export interface RouteWindow {
  method: string;
  route: string;
  requests: number;
  serverErrors: number;
  conflicts: number;
  unauthorized: number;
  forbidden: number;
  notFound: number;
  aborted: number;
  /** Requests per latency slot (`REQUEST_LATENCY_BOUNDS_MS` plus overflow). */
  latencyHistogram: number[];
}

export interface OperationalSnapshot {
  routes: RouteWindow[];
  ai: AiOperationalStats;
  database: { connections: number; maxConnections: number };
}

export type AlertName =
  | 'save_error_rate'
  | 'api_error_rate'
  | 'latency_p95'
  | 'ai_queue_age'
  | 'authorization_anomaly'
  | 'ai_spend_cap'
  | 'export_failures'
  | 'ai_invalid_output'
  | 'ai_provider_failures'
  | 'database_saturation';

/**
 * A firing alert. Every field is a fixed name, a number, or a route pattern from the code: the
 * whole object is safe to log (NFR-PRIV-001).
 */
export interface Alert {
  alert: AlertName;
  /** Identity across evaluations (the alert name, plus method and route for per-route rules). */
  key: string;
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  windowMinutes?: number;
  sampleSize?: number;
  method?: string;
  route?: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Export creation, status and download routes. */
export function isExportRoute(route: string): boolean {
  return route.endsWith('/exports') || route.startsWith('/v1/exports');
}

/**
 * A "save": a mutation of study content (every write under `/v1/studies`, which is where the
 * autosave queue sends its requests), except export creation, which has its own rule.
 */
export function isSave(method: string, route: string): boolean {
  return MUTATING_METHODS.has(method) && route.startsWith('/v1/studies') && !isExportRoute(route);
}

/**
 * The section 22 p95 server-latency target for a route, or null when none applies: unmatched
 * requests, the platform probes and OpenAPI document, sign-in (third-party identity latency is
 * excluded by NFR-PERF-001) and exports (bounded by size, not a latency target).
 */
export function latencyTargetMs(route: string): number | null {
  if (
    route === 'unmatched' ||
    route.startsWith('/v1/health') ||
    route === '/v1/openapi.json' ||
    route.startsWith('/v1/auth/') ||
    isExportRoute(route)
  ) {
    return null;
  }
  return route === '/v1/bible/search' ? 750 : 500;
}

/** Requests at or under `targetMs` (a histogram bound). */
function withinTarget(histogram: readonly number[], targetMs: number): number {
  const lastSlot = REQUEST_LATENCY_BOUNDS_MS.indexOf(targetMs);
  return histogram.slice(0, lastSlot + 1).reduce((sum, count) => sum + count, 0);
}

const SLOWEST_BOUND_MS = REQUEST_LATENCY_BOUNDS_MS[REQUEST_LATENCY_BOUNDS_MS.length - 1] ?? 0;

/**
 * The histogram's q-quantile as the upper bound (ms) of the slot it falls in. A quantile in the
 * overflow slot reports the slowest bound (10000, read as "over 10 s"), so the value stays a
 * finite number in JSON logs. Null for an empty histogram.
 */
export function quantileUpperBoundMs(histogram: readonly number[], q: number): number | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [slot, count] of histogram.entries()) {
    seen += count;
    if (seen >= q * total) return REQUEST_LATENCY_BOUNDS_MS[slot] ?? SLOWEST_BOUND_MS;
  }
  return SLOWEST_BOUND_MS;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Window totals derived from the snapshot: the content-free `ops_metrics` line. */
export interface MetricsSummary {
  requests: number;
  serverErrors: number;
  serverErrorRate: number;
  saves: number;
  saveFailures: number;
  saveFailureRate: number;
  saveConflicts: number;
  saveConflictRate: number;
  exportRequests: number;
  exportFailures: number;
  unauthorized: number;
  authorizationDenials: number;
  abortedRequests: number;
  routesOverLatencyTarget: number;
  aiQueuedJobs: number;
  aiRunningJobs: number;
  aiOldestEligibleJobSeconds: number;
  aiFinishedJobs: number;
  aiInvalidOutputJobs: number;
  aiProviderFailedJobs: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiWindowCostMicros: number;
  aiMonthSpendMicros: number;
  aiMonthSpendCapMicros: number;
  databaseConnections: number;
  databaseMaxConnections: number;
}

interface Totals {
  requests: number;
  serverErrors: number;
  saves: number;
  saveFailures: number;
  saveConflicts: number;
  exportRequests: number;
  exportFailures: number;
  unauthorized: number;
  denials: number;
  aborted: number;
}

function totals(routes: readonly RouteWindow[]): Totals {
  const sum: Totals = {
    requests: 0,
    serverErrors: 0,
    saves: 0,
    saveFailures: 0,
    saveConflicts: 0,
    exportRequests: 0,
    exportFailures: 0,
    unauthorized: 0,
    denials: 0,
    aborted: 0,
  };
  for (const r of routes) {
    sum.requests += r.requests;
    sum.serverErrors += r.serverErrors;
    sum.unauthorized += r.unauthorized;
    sum.aborted += r.aborted;
    // An unknown path's 404 is a scanner or a stale client, not an owner-scope refusal.
    sum.denials += r.forbidden + (r.route === 'unmatched' ? 0 : r.notFound);
    if (isSave(r.method, r.route)) {
      sum.saves += r.requests;
      sum.saveFailures += r.serverErrors;
      sum.saveConflicts += r.conflicts;
    }
    if (isExportRoute(r.route)) {
      sum.exportRequests += r.requests;
      sum.exportFailures += r.serverErrors;
    }
  }
  return sum;
}

/** Routes whose p95 is over target, with enough traffic to say so. */
function slowRoutes(routes: readonly RouteWindow[]): Alert[] {
  const t = ALERT_THRESHOLDS;
  const alerts: Alert[] = [];
  for (const r of routes) {
    const target = latencyTargetMs(r.route);
    if (target === null || r.requests < t.minRequests) continue;
    if (ratio(withinTarget(r.latencyHistogram, target), r.requests) >= t.latencyQuantile) continue;
    alerts.push({
      alert: 'latency_p95',
      key: `latency_p95 ${r.method} ${r.route}`,
      severity: 'warning',
      value: quantileUpperBoundMs(r.latencyHistogram, t.latencyQuantile) ?? 0,
      threshold: target,
      windowMinutes: t.requestWindowMinutes,
      sampleSize: r.requests,
      method: r.method,
      route: r.route,
    });
  }
  return alerts;
}

export function summarize(snapshot: OperationalSnapshot): MetricsSummary {
  const sum = totals(snapshot.routes);
  const { ai, database } = snapshot;
  return {
    requests: sum.requests,
    serverErrors: sum.serverErrors,
    serverErrorRate: round(ratio(sum.serverErrors, sum.requests)),
    saves: sum.saves,
    saveFailures: sum.saveFailures,
    saveFailureRate: round(ratio(sum.saveFailures, sum.saves)),
    saveConflicts: sum.saveConflicts,
    saveConflictRate: round(ratio(sum.saveConflicts, sum.saves)),
    exportRequests: sum.exportRequests,
    exportFailures: sum.exportFailures,
    unauthorized: sum.unauthorized,
    authorizationDenials: sum.denials,
    abortedRequests: sum.aborted,
    routesOverLatencyTarget: slowRoutes(snapshot.routes).length,
    aiQueuedJobs: ai.queuedJobs,
    aiRunningJobs: ai.runningJobs,
    aiOldestEligibleJobSeconds: ai.oldestEligibleJobSeconds,
    aiFinishedJobs: ai.finishedJobs,
    aiInvalidOutputJobs: ai.invalidOutputJobs,
    aiProviderFailedJobs: ai.providerFailedJobs,
    aiInputTokens: ai.windowInputTokens,
    aiOutputTokens: ai.windowOutputTokens,
    aiWindowCostMicros: ai.windowCostMicros,
    aiMonthSpendMicros: ai.monthSpendMicros,
    aiMonthSpendCapMicros: ai.monthSpendCapMicros,
    databaseConnections: database.connections,
    databaseMaxConnections: database.maxConnections,
  };
}

/** Every alert the snapshot fires, most severe rules first. */
export function evaluateAlerts(snapshot: OperationalSnapshot): Alert[] {
  const t = ALERT_THRESHOLDS;
  const sum = totals(snapshot.routes);
  const { ai, database } = snapshot;
  const alerts: Alert[] = [];
  const requestWindow = { windowMinutes: t.requestWindowMinutes };
  const aiWindow = { windowMinutes: t.aiWindowMinutes };

  const saveRate = ratio(sum.saveFailures, sum.saves);
  if (sum.saves >= t.minRequests && saveRate > t.saveFailureRate) {
    alerts.push({
      alert: 'save_error_rate',
      key: 'save_error_rate',
      severity: 'critical',
      value: round(saveRate),
      threshold: t.saveFailureRate,
      ...requestWindow,
      sampleSize: sum.saves,
    });
  }

  const apiRate = ratio(sum.serverErrors, sum.requests);
  if (sum.requests >= t.minRequests && apiRate > t.apiServerErrorRate) {
    alerts.push({
      alert: 'api_error_rate',
      key: 'api_error_rate',
      severity: 'critical',
      value: round(apiRate),
      threshold: t.apiServerErrorRate,
      ...requestWindow,
      sampleSize: sum.requests,
    });
  }

  if (ai.oldestEligibleJobSeconds > t.oldestEligibleJobSeconds) {
    alerts.push({
      alert: 'ai_queue_age',
      key: 'ai_queue_age',
      severity: 'critical',
      value: ai.oldestEligibleJobSeconds,
      threshold: t.oldestEligibleJobSeconds,
      sampleSize: ai.queuedJobs + ai.runningJobs,
    });
  }

  const dbRatio = ratio(database.connections, database.maxConnections);
  if (database.maxConnections > 0 && dbRatio >= t.databaseConnectionRatio) {
    alerts.push({
      alert: 'database_saturation',
      key: 'database_saturation',
      severity: 'critical',
      value: round(dbRatio),
      threshold: t.databaseConnectionRatio,
      sampleSize: database.connections,
    });
  }

  const spendRatio = ratio(ai.monthSpendMicros, ai.monthSpendCapMicros);
  if (ai.monthSpendCapMicros > 0 && spendRatio >= t.spendCapWarningRatio) {
    alerts.push({
      alert: 'ai_spend_cap',
      key: 'ai_spend_cap',
      // At the cap AI is paused for everyone until next month (section 25).
      severity: spendRatio >= 1 ? 'critical' : 'warning',
      value: round(spendRatio),
      threshold: t.spendCapWarningRatio,
    });
  }

  alerts.push(...slowRoutes(snapshot.routes));

  const denialRate = ratio(sum.denials, sum.requests);
  if (sum.denials >= t.authorizationDenials && denialRate >= t.authorizationDenialRate) {
    alerts.push({
      alert: 'authorization_anomaly',
      key: 'authorization_anomaly',
      severity: 'warning',
      value: sum.denials,
      threshold: t.authorizationDenials,
      ...requestWindow,
      sampleSize: sum.requests,
    });
  }

  if (sum.exportFailures >= t.exportFailures) {
    alerts.push({
      alert: 'export_failures',
      key: 'export_failures',
      severity: 'warning',
      value: sum.exportFailures,
      threshold: t.exportFailures,
      ...requestWindow,
      sampleSize: sum.exportRequests,
    });
  }

  if (ai.finishedJobs >= t.minAiJobs) {
    const invalidRate = ratio(ai.invalidOutputJobs, ai.finishedJobs);
    if (invalidRate >= t.aiInvalidOutputRate) {
      alerts.push({
        alert: 'ai_invalid_output',
        key: 'ai_invalid_output',
        severity: 'warning',
        value: round(invalidRate),
        threshold: t.aiInvalidOutputRate,
        ...aiWindow,
        sampleSize: ai.finishedJobs,
      });
    }
    const providerRate = ratio(ai.providerFailedJobs, ai.finishedJobs);
    if (providerRate >= t.aiProviderFailureRate) {
      alerts.push({
        alert: 'ai_provider_failures',
        key: 'ai_provider_failures',
        severity: 'warning',
        value: round(providerRate),
        threshold: t.aiProviderFailureRate,
        ...aiWindow,
        sampleSize: ai.finishedJobs,
      });
    }
  }
  return alerts;
}
