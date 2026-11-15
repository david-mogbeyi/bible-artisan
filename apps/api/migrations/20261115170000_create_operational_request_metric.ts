import type { MigrationContext } from '../src/database/migrator';

// BIB-50: content-free HTTP request metrics for operational alerts (PRD sections 22, 30).
//
// One row per minute, HTTP method and matched route PATTERN (`/v1/studies/:studyId`, or
// `unmatched`), summed across every API process: each process aggregates in memory and upserts
// its counts every few seconds (`RequestMetricsFlusher`), and the worker's alert evaluator reads
// the last 15 minutes (`OperationalMetricsService`). PostgreSQL is the metrics store (AGENTS.md
// rule 9: no Prometheus, StatsD or broker until measurements justify one).
//
// Nothing here is private: no owner or study ids, no raw paths, query strings or bodies. Route
// patterns and methods come from the code, statuses are counted by class, and latency is a fixed
// histogram (`latency_histogram[i]` counts requests at or under `REQUEST_LATENCY_BOUNDS_MS[i]`,
// the last slot everything slower). The worker deletes rows older than 30 days (section 30's
// operational metadata retention). Observability module owns the table.
//
// `down` drops the table: it holds derived operational counters only, never user data.
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`
    CREATE TABLE operational_request_metric (
      bucket_start timestamptz NOT NULL,
      method text NOT NULL,
      route text NOT NULL,
      request_count integer NOT NULL DEFAULT 0,
      server_error_count integer NOT NULL DEFAULT 0,
      conflict_count integer NOT NULL DEFAULT 0,
      unauthorized_count integer NOT NULL DEFAULT 0,
      forbidden_count integer NOT NULL DEFAULT 0,
      not_found_count integer NOT NULL DEFAULT 0,
      aborted_count integer NOT NULL DEFAULT 0,
      latency_histogram integer[] NOT NULL,
      PRIMARY KEY (bucket_start, method, route),
      CONSTRAINT operational_request_metric_minute_check
        CHECK (bucket_start = date_trunc('minute', bucket_start)),
      CONSTRAINT operational_request_metric_label_check
        CHECK (char_length(method) BETWEEN 1 AND 16 AND char_length(route) BETWEEN 1 AND 300),
      CONSTRAINT operational_request_metric_counts_check
        CHECK (request_count >= 0
               AND server_error_count BETWEEN 0 AND request_count
               AND conflict_count BETWEEN 0 AND request_count
               AND unauthorized_count BETWEEN 0 AND request_count
               AND forbidden_count BETWEEN 0 AND request_count
               AND not_found_count BETWEEN 0 AND request_count
               AND aborted_count BETWEEN 0 AND request_count),
      CONSTRAINT operational_request_metric_histogram_check
        CHECK (cardinality(latency_histogram) = 11 AND array_ndims(latency_histogram) = 1
               AND array_position(latency_histogram, NULL) IS NULL
               AND 0 <= ALL (latency_histogram))
    );
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  await context.query(`DROP TABLE operational_request_metric;`);
}
