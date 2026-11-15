import { Module } from '@nestjs/common';
import { REQUEST_METRICS, RequestMetricsFlusher } from './request-metrics-flusher.service';
import { requestMetrics } from './request-metrics';

/**
 * Observability bounded context (PRD §26, BIB-13). Content-redacted operational logging lives
 * here as plain functions, because it runs outside Nest's DI container: `requestLogging` is an
 * Express middleware registered first in `configureApp`, `createAppLogger` builds the process
 * logger before the app exists, and `correlationIdOf` is shared with the global exception filter.
 * Every logged field is allowlisted at its call site (NFR-PRIV-001): never URLs, query strings,
 * params, headers, cookies, bodies, or error messages.
 *
 * BIB-50: the API side of the operational metrics. `requestLogging` counts each request into the
 * process-wide `requestMetrics`, and `RequestMetricsFlusher` writes the counts to
 * `operational_request_metric` (owned here). The worker evaluates them in
 * `OperationalAlertsModule`.
 */
@Module({
  providers: [{ provide: REQUEST_METRICS, useValue: requestMetrics }, RequestMetricsFlusher],
  exports: [RequestMetricsFlusher],
})
export class ObservabilityModule {}
