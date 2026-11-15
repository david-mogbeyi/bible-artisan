import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { errorTypeOf } from './correlation';
import { type RequestMetricRow, RequestMetricsRecorder } from './request-metrics';

/** The recorder the flusher drains (the process-wide `requestMetrics`; tests pass their own). */
export const REQUEST_METRICS = Symbol('REQUEST_METRICS');

/** How often an API process writes its counts. Short, so the 15-minute windows stay current. */
export const REQUEST_METRICS_FLUSH_MS = 10_000;

/** Rows per INSERT statement (11 bind parameters each). */
const ROWS_PER_STATEMENT = 400;

const COLUMNS = 11;

/**
 * Upserts the API process's in-memory request counts into `operational_request_metric` (BIB-50)
 * every `REQUEST_METRICS_FLUSH_MS`, and once more before shutdown. Counts from several API
 * processes for the same minute and route are summed by the upsert (histograms slot by slot).
 *
 * A failed flush puts the rows back for the next attempt and logs one content-free line
 * (`ops_metrics_flush_failed` with the error class and row count); it never affects requests.
 */
@Injectable()
export class RequestMetricsFlusher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OpsMetrics');
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<number> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REQUEST_METRICS) private readonly recorder: RequestMetricsRecorder,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.flush(), REQUEST_METRICS_FLUSH_MS);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Writes everything pending; resolves to the number of rows written (0 on failure). */
  flush(): Promise<number> {
    // One flush at a time: a slow database must not stack concurrent upserts of the same keys.
    this.flushing ??= this.write().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(): Promise<number> {
    const { rows, dropped } = this.recorder.drain();
    if (dropped > 0) this.logger.warn('ops_metrics_dropped', { requests: dropped });
    if (rows.length === 0) return 0;
    try {
      for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
        await this.upsert(rows.slice(start, start + ROWS_PER_STATEMENT));
      }
      return rows.length;
    } catch (error) {
      // Rows of a chunk that did commit may be counted again; a rare over-count is preferable
      // to losing a failure window, and it can only happen when the database was failing.
      this.recorder.restore(rows);
      this.logger.error('ops_metrics_flush_failed', {
        errorType: errorTypeOf(error),
        rows: rows.length,
      });
      return 0;
    }
  }

  private async upsert(rows: readonly RequestMetricRow[]): Promise<void> {
    const bind: unknown[] = [];
    const tuples = rows.map((row, index) => {
      bind.push(
        row.bucketStart.toISOString(),
        row.method,
        row.route,
        row.requestCount,
        row.serverErrorCount,
        row.conflictCount,
        row.unauthorizedCount,
        row.forbiddenCount,
        row.notFoundCount,
        row.abortedCount,
        row.latencyHistogram,
      );
      const p = (column: number): string => `$${index * COLUMNS + column}`;
      return `(${p(1)}::timestamptz, ${p(2)}, ${p(3)}, ${p(4)}::int, ${p(5)}::int, ${p(6)}::int,
               ${p(7)}::int, ${p(8)}::int, ${p(9)}::int, ${p(10)}::int, ${p(11)}::int[])`;
    });
    await this.db.query(
      `INSERT INTO operational_request_metric AS m
         (bucket_start, method, route, request_count, server_error_count, conflict_count,
          unauthorized_count, forbidden_count, not_found_count, aborted_count, latency_histogram)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (bucket_start, method, route) DO UPDATE SET
         request_count = m.request_count + EXCLUDED.request_count,
         server_error_count = m.server_error_count + EXCLUDED.server_error_count,
         conflict_count = m.conflict_count + EXCLUDED.conflict_count,
         unauthorized_count = m.unauthorized_count + EXCLUDED.unauthorized_count,
         forbidden_count = m.forbidden_count + EXCLUDED.forbidden_count,
         not_found_count = m.not_found_count + EXCLUDED.not_found_count,
         aborted_count = m.aborted_count + EXCLUDED.aborted_count,
         latency_histogram = ARRAY(
           SELECT a + b
             FROM unnest(m.latency_histogram, EXCLUDED.latency_histogram)
                  WITH ORDINALITY AS slot(a, b, i)
            ORDER BY i
         )`,
      { bind },
    );
  }
}
