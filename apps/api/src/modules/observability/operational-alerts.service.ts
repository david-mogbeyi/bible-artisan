import { Inject, Injectable, Logger } from '@nestjs/common';
import { literal, Op, QueryTypes } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { OperationalRequestMetric } from '../../database/models/operational-request-metric.model';
import { AiOperationsService } from '../ai/ai-operations.service';
import {
  type Alert,
  ALERT_THRESHOLDS,
  evaluateAlerts,
  type MetricsSummary,
  type OperationalSnapshot,
  type RouteWindow,
  summarize,
} from './alert-rules';
import { errorTypeOf } from './correlation';
import { LATENCY_SLOTS } from './request-metrics';

/** How often the worker evaluates the alert rules. */
export const ALERT_EVALUATION_INTERVAL_MS = 60_000;

/** Section 30: operational metadata is retained for 30 days. */
export const OPERATIONAL_METRIC_RETENTION_DAYS = 30;

export interface Evaluation {
  metrics: MetricsSummary;
  firing: Alert[];
  resolved: Alert[];
}

/**
 * The worker's alert evaluator (BIB-50, PRD section 30). Every minute it reads the last 15
 * minutes of `operational_request_metric` (written by the API processes), the AI job queue and
 * spend (through `AiOperationsService`) and the database's connection count, then:
 *
 * - logs one `ops_metrics` line with the window's totals;
 * - logs one `ops_alert` line (`state: firing`; `error` level when critical, `warn` otherwise)
 *   for every rule that fires, on every evaluation while it keeps firing, so a log-based alert
 *   in any backend can match on `message = ops_alert`;
 * - logs one `ops_alert` line with `state: resolved` when a firing rule clears;
 * - deletes request metrics older than 30 days.
 *
 * Every logged value is a fixed name, a number or a route pattern from the code; no owner,
 * study, query or content ever reaches these lines (NFR-PRIV-001). A failed evaluation logs one
 * content-free line and is retried at the next tick; it never stops the worker.
 */
@Injectable()
export class OperationalAlertsService {
  private readonly logger = new Logger('OpsAlerts');
  /** Alerts firing at the last evaluation, by key, with when they started firing. */
  private firing = new Map<string, { alert: Alert; since: number }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AiOperationsService,
  ) {}

  /** Evaluates now and then every `intervalMs`, one run at a time. Returns a stop function. */
  start(intervalMs = ALERT_EVALUATION_INTERVAL_MS): () => void {
    let running = false;
    const run = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        await this.evaluate(new Date());
        await this.purgeExpired();
      } catch (error) {
        this.logger.error('ops_alerts_failed', { errorType: errorTypeOf(error) });
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
  }

  /** Reads the snapshot at `at`, logs the metrics and alert transitions, and returns them. */
  async evaluate(at: Date): Promise<Evaluation> {
    const snapshot = await this.snapshot(at);
    const metrics = summarize(snapshot);
    const alerts = evaluateAlerts(snapshot);
    this.logger.log('ops_metrics', {
      windowMinutes: ALERT_THRESHOLDS.requestWindowMinutes,
      aiWindowMinutes: ALERT_THRESHOLDS.aiWindowMinutes,
      ...metrics,
    });

    const now = at.getTime();
    const next = new Map<string, { alert: Alert; since: number }>();
    for (const alert of alerts) {
      const since = this.firing.get(alert.key)?.since ?? now;
      next.set(alert.key, { alert, since });
      const fields = { state: 'firing', ...logged(alert), firingSeconds: (now - since) / 1000 };
      if (alert.severity === 'critical') this.logger.error('ops_alert', fields);
      else this.logger.warn('ops_alert', fields);
    }
    const resolved = [...this.firing.values()]
      .filter(({ alert }) => !next.has(alert.key))
      .map(({ alert, since }) => {
        this.logger.log('ops_alert', {
          state: 'resolved',
          ...logged(alert),
          firingSeconds: (now - since) / 1000,
        });
        return alert;
      });
    this.firing = next;
    return { metrics, firing: alerts, resolved };
  }

  /** The content-free inputs of the rules, as of `at`. */
  async snapshot(at: Date): Promise<OperationalSnapshot> {
    const windowStart = new Date(at.getTime() - ALERT_THRESHOLDS.requestWindowMinutes * 60_000);
    const [rows, ai, database] = await Promise.all([
      OperationalRequestMetric.findAll({
        where: { bucketStart: { [Op.gt]: windowStart, [Op.lte]: at } },
        raw: true,
      }),
      this.ai.stats(at, ALERT_THRESHOLDS.aiWindowMinutes),
      this.databaseConnections(),
    ]);
    const routes = new Map<string, RouteWindow>();
    for (const row of rows) {
      const key = `${row.method} ${row.route}`;
      let route = routes.get(key);
      if (!route) {
        route = {
          method: row.method,
          route: row.route,
          requests: 0,
          serverErrors: 0,
          conflicts: 0,
          unauthorized: 0,
          forbidden: 0,
          notFound: 0,
          aborted: 0,
          latencyHistogram: new Array<number>(LATENCY_SLOTS).fill(0),
        };
        routes.set(key, route);
      }
      route.requests += row.requestCount;
      route.serverErrors += row.serverErrorCount;
      route.conflicts += row.conflictCount;
      route.unauthorized += row.unauthorizedCount;
      route.forbidden += row.forbiddenCount;
      route.notFound += row.notFoundCount;
      route.aborted += row.abortedCount;
      row.latencyHistogram.forEach((count, slot) => {
        route.latencyHistogram[slot] = (route.latencyHistogram[slot] ?? 0) + count;
      });
    }
    return { routes: [...routes.values()], ai, database };
  }

  /** Deletes request metrics past the 30-day retention. Returns the rows deleted. */
  async purgeExpired(): Promise<number> {
    return OperationalRequestMetric.destroy({
      where: {
        bucketStart: {
          [Op.lt]: literal(`now() - interval '${OPERATIONAL_METRIC_RETENTION_DAYS} days'`),
        },
      },
    });
  }

  /** Client connections across the server against `max_connections` (pool saturation). */
  private async databaseConnections(): Promise<OperationalSnapshot['database']> {
    const [row] = await this.db.query<{ connections: number; max_connections: number }>(
      `SELECT count(*)::int AS connections,
              current_setting('max_connections')::int AS max_connections
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'`,
      { type: QueryTypes.SELECT },
    );
    return {
      connections: row?.connections ?? 0,
      maxConnections: row?.max_connections ?? 0,
    };
  }
}

/** The alert's loggable fields (all of them except the internal `key`). */
function logged(alert: Alert): Omit<Alert, 'key'> {
  const { key: _key, ...fields } = alert;
  return fields;
}
