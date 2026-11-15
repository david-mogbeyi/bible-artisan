# Operational metrics and alerts

BIB-50 adds the operational metrics and alerts from PRD section 30. They run on PostgreSQL and the existing processes, with no new infrastructure (AGENTS.md rule 9). Alerts are structured log lines, so any log-based alerting backend can page on them.

## How it works

```
API process(es)                         PostgreSQL                         worker
requestLogging ──► RequestMetricsRecorder ──(every 10 s)──► operational_request_metric ──┐
                    (in memory, per minute/route)            ai_job, pg_stat_activity ───┤
                                                                                          ▼
                                                             OperationalAlertsService (every 60 s)
                                                             ├─ ops_metrics  (one line per run)
                                                             └─ ops_alert    (firing / resolved)
```

- **API.** `requestLogging` already reduces each request to allowlisted fields: method, matched route pattern, status, and duration. The same fields go to `requestMetrics`, which counts per minute, method, and route: requests, 5xx, 409, 401, 403, 404, aborted, and an 11-slot latency histogram. `RequestMetricsFlusher` upserts the counts into `operational_request_metric` every 10 seconds and once more on shutdown. Several API instances sum into the same rows.
- **Worker.** `OperationalAlertsService` reads the last 15 minutes of request metrics, AI job statistics for the last hour, and the AI spend for the month (through `AiOperationsService`, since the AI module owns `ai_job`). It also reads the server's client connections against `max_connections`. It evaluates `evaluateAlerts` (`apps/api/src/modules/observability/alert-rules.ts`), logs the results, and deletes request metrics older than 30 days.

## Alert rules

| Alert                   | Fires when                                                                                                                                                                                                      | Severity                  | Source     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------- |
| `save_error_rate`       | Over 15 min, saves (writes under `/v1/studies`, except exports) ≥ 20 and 5xx share > 1%                                                                                                                         | critical                  | PRD §30    |
| `latency_p95`           | Over 15 min, a route with ≥ 20 requests has < 95% of them within its target: 500 ms, or 750 ms for `/v1/bible/search` (PRD §22). Excludes sign-in, probes, OpenAPI, exports and unmatched. One alert per route. | warning                   | PRD §22/30 |
| `ai_queue_age`          | The oldest claimable AI job (queued past `available_at`, or running with an expired lease) has waited > 5 min                                                                                                   | critical                  | PRD §30    |
| `authorization_anomaly` | Over 15 min, 403s plus 404s on matched routes ≥ 50 **and** ≥ 10% of requests. Cross-owner access answers 404 (NFR-SEC-001), so probing shows up here                                                            | warning                   | PRD §30    |
| `ai_spend_cap`          | This month's AI spend ≥ 80% of `AI_MONTHLY_SPEND_CAP_USD`                                                                                                                                                       | warning, critical at 100% | PRD §30    |
| `api_error_rate`        | Over 15 min, ≥ 20 requests and 5xx share > 5%                                                                                                                                                                   | critical                  | default    |
| `export_failures`       | Any 5xx on an export route in 15 min                                                                                                                                                                            | warning                   | default    |
| `ai_invalid_output`     | Over 1 h, ≥ 5 finished AI jobs and ≥ 20% `VALIDATION_FAILED`                                                                                                                                                    | warning                   | default    |
| `ai_provider_failures`  | Over 1 h, ≥ 5 finished AI jobs and ≥ 50% `PROVIDER_*` / `LEASE_EXPIRED`                                                                                                                                         | warning                   | default    |
| `database_saturation`   | Client connections ≥ 80% of `max_connections`                                                                                                                                                                   | critical                  | default    |

"PRD" rows use the section 30 thresholds. "Default" rows are operational metrics that section 30 lists without a number, so this ticket picked the values. All the numbers live in `ALERT_THRESHOLDS`. The minimum sample sizes keep one stray failure at pilot traffic from paging anyone.

## Log lines

Both lines are JSON in production (`createAppLogger`). Every field is a fixed name, a number, or a route pattern from the code. There are no owner, study, or job IDs, no paths or queries, and no content (NFR-PRIV-001). The `log-redaction` and `operational-alerts` integration suites check this.

```json
{"level":"error","message":"ops_alert","context":"OpsAlerts","state":"firing","alert":"save_error_rate","severity":"critical","value":0.02,"threshold":0.01,"windowMinutes":15,"sampleSize":200,"firingSeconds":120}
{"level":"log","message":"ops_alert","context":"OpsAlerts","state":"resolved","alert":"save_error_rate","severity":"critical","value":0.02,"threshold":0.01,"windowMinutes":15,"sampleSize":200,"firingSeconds":900}
{"level":"log","message":"ops_metrics","context":"OpsAlerts","windowMinutes":15,"requests":301,"saveFailureRate":0.02,"aiOldestEligibleJobSeconds":0,"databaseConnections":7,"...":"..."}
```

- `ops_alert` with `state: "firing"` repeats on every evaluation (once a minute) while the condition holds. `firingSeconds` says how long it has held. Critical alerts log at `error`, warnings at `warn`.
- `ops_alert` with `state: "resolved"` is logged once when it clears.
- `latency_p95` alerts also carry `method` and `route`. Their `value` is the upper bound of the latency slot that holds the p95, and `10000` means over 10 s.
- `ops_metrics` is logged once a minute with the window's totals: request, save, conflict, and export counts and rates, 401s and denials, AI queue, tokens, and spend, and database connections. Use it for dashboards.
- `ops_metrics_flush_failed` (API) and `ops_alerts_failed` (worker) carry only `errorType`. A failed flush is retried on the next one.

## Hooking up a real alerting backend

No backend is configured yet. To add one without changing the application:

1. **Ship the logs.** Point the platform's log drain (Render, Fly, Railway, a Vector or Fluent Bit sidecar, and so on) at your provider: Datadog, Grafana Loki, Better Stack, CloudWatch, or another. The lines are already one JSON object each.
2. **Create log-based monitors**, for example:
   - Page on `message:ops_alert AND state:firing AND severity:critical`, grouped by `alert` (and `route` for latency).
   - Notify on `message:ops_alert AND state:firing AND severity:warning`.
   - Optionally auto-resolve on `message:ops_alert AND state:resolved` with the same grouping.
   - Alert when no `ops_metrics` line has arrived for 5 minutes. That means the worker or the evaluator is down.
3. **Dashboards.** Chart the numeric fields of `ops_metrics`, or query `operational_request_metric` directly. It keeps 30 days of per-minute, per-route counts and latency histograms.

If a metrics backend (Prometheus or OpenTelemetry) is introduced later, export from `OperationalAlertsService.snapshot()` or from `RequestMetricsRecorder`. Both are already content-free. Keep the redaction tests passing for any new exporter.

## Not covered yet

- Per-process connection-pool wait times. Pool saturation is measured as server-wide connections against `max_connections`.
- Summary freshness and reference-validation failures as separate metrics. AI output that fails validation, invalid references included, ends the job as `VALIDATION_FAILED`, which feeds `ai_invalid_output`. Individual passage candidates dropped because their reference does not resolve are not counted.
- An operator HTTP endpoint for metrics. The PRD defines no operator role or route, so metrics are available through logs and the table only.
