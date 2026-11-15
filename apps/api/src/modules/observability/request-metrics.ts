/**
 * In-process HTTP request metrics (BIB-50, PRD section 30): what `requestLogging` already knows
 * about each request (method, matched route PATTERN, status, duration), counted per minute. Each
 * API process keeps one `RequestMetricsRecorder`; `RequestMetricsFlusher` upserts its counts into
 * `operational_request_metric` every few seconds, where the worker's alert evaluator reads them.
 *
 * Only allowlisted, server-generated labels are kept (NFR-PRIV-001): the same `method` and
 * `route` values the access log carries, never a raw path, query string, header or body.
 */

/**
 * Upper bounds (inclusive, milliseconds) of the latency histogram slots. A request slower than
 * the last bound lands in the extra overflow slot, so a histogram has `length + 1` slots. The
 * PRD's targets (500 ms for reads and mutations, 750 ms for search; section 22) are bounds, so
 * "p95 over target" is exact: fewer than 95% of requests landed at or under the target bound.
 */
export const REQUEST_LATENCY_BOUNDS_MS = [25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 10000];

/** Slots in a histogram: one per bound plus overflow (the migration's CHECK requires 11). */
export const LATENCY_SLOTS = REQUEST_LATENCY_BOUNDS_MS.length + 1;

/** The histogram slot for one duration. */
export function latencySlot(durationMs: number): number {
  const index = REQUEST_LATENCY_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
  return index === -1 ? REQUEST_LATENCY_BOUNDS_MS.length : index;
}

/** Counters for one (minute, method, route): the shape of an `operational_request_metric` row. */
export interface RequestMetricRow {
  bucketStart: Date;
  method: string;
  route: string;
  requestCount: number;
  serverErrorCount: number;
  conflictCount: number;
  unauthorizedCount: number;
  forbiddenCount: number;
  notFoundCount: number;
  abortedCount: number;
  latencyHistogram: number[];
}

/** One finished request, as `requestLogging` saw it (status null: aborted before headers). */
export interface ObservedRequest {
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  aborted: boolean;
}

/**
 * Distinct (minute, method, route) keys held before new keys are dropped. Routes are code
 * patterns (about a hundred) and the flusher drains every few seconds, so this is only a guard
 * against unbounded growth while the database is unreachable.
 */
export const MAX_PENDING_KEYS = 5000;

const MINUTE_MS = 60_000;

function emptyRow(bucketStart: Date, method: string, route: string): RequestMetricRow {
  return {
    bucketStart,
    method,
    route,
    requestCount: 0,
    serverErrorCount: 0,
    conflictCount: 0,
    unauthorizedCount: 0,
    forbiddenCount: 0,
    notFoundCount: 0,
    abortedCount: 0,
    latencyHistogram: new Array<number>(LATENCY_SLOTS).fill(0),
  };
}

function addInto(target: RequestMetricRow, source: RequestMetricRow): void {
  target.requestCount += source.requestCount;
  target.serverErrorCount += source.serverErrorCount;
  target.conflictCount += source.conflictCount;
  target.unauthorizedCount += source.unauthorizedCount;
  target.forbiddenCount += source.forbiddenCount;
  target.notFoundCount += source.notFoundCount;
  target.abortedCount += source.abortedCount;
  source.latencyHistogram.forEach((count, slot) => {
    target.latencyHistogram[slot] = (target.latencyHistogram[slot] ?? 0) + count;
  });
}

export class RequestMetricsRecorder {
  private pending = new Map<string, RequestMetricRow>();
  /** Requests not counted because `MAX_PENDING_KEYS` was reached; reported by the flusher. */
  private dropped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  record(request: ObservedRequest): void {
    const row = this.rowFor(new Date(Math.floor(this.now() / MINUTE_MS) * MINUTE_MS), request);
    if (!row) {
      this.dropped += 1;
      return;
    }
    row.requestCount += 1;
    const { status } = request;
    if (status !== null && status >= 500) row.serverErrorCount += 1;
    if (status === 409) row.conflictCount += 1;
    if (status === 401) row.unauthorizedCount += 1;
    if (status === 403) row.forbiddenCount += 1;
    if (status === 404) row.notFoundCount += 1;
    if (request.aborted) row.abortedCount += 1;
    const slot = latencySlot(request.durationMs);
    row.latencyHistogram[slot] = (row.latencyHistogram[slot] ?? 0) + 1;
  }

  /** Takes every pending row (and the dropped count), leaving the recorder empty. */
  drain(): { rows: RequestMetricRow[]; dropped: number } {
    const rows = [...this.pending.values()];
    const { dropped } = this;
    this.pending = new Map();
    this.dropped = 0;
    return { rows, dropped };
  }

  /** Puts rows back after a failed flush, so the next flush retries them (bounded). */
  restore(rows: readonly RequestMetricRow[]): void {
    for (const row of rows) {
      const target = this.rowFor(row.bucketStart, row);
      if (target) addInto(target, row);
      else this.dropped += row.requestCount;
    }
  }

  private rowFor(
    bucketStart: Date,
    labels: { method: string; route: string },
  ): RequestMetricRow | undefined {
    const key = `${bucketStart.getTime()} ${labels.method} ${labels.route}`;
    let row = this.pending.get(key);
    if (!row) {
      if (this.pending.size >= MAX_PENDING_KEYS) return undefined;
      row = emptyRow(bucketStart, labels.method, labels.route);
      this.pending.set(key, row);
    }
    return row;
  }
}

/**
 * The process-wide recorder. `requestLogging` is a plain Express middleware registered before
 * Nest's container is involved, so it records here; the flusher (a Nest provider in the API)
 * drains the same instance.
 */
export const requestMetrics = new RequestMetricsRecorder();
