import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { AI_RUNTIME, type AiRuntime } from './provider/ai-provider';

/** Job errors that mean the provider (or the worker running it) failed, not the user's state. */
const PROVIDER_FAILURES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSED',
  'PROVIDER_ERROR',
  'LEASE_EXPIRED',
];

/**
 * Content-free AI job statistics for the operational alerts (BIB-50, PRD section 30): counts,
 * ages and spend only, never job input, prompts or results.
 */
export interface AiOperationalStats {
  queuedJobs: number;
  runningJobs: number;
  /**
   * Seconds the oldest job that a worker could claim right now has been waiting: a queued job
   * past its `available_at`, or a running job whose lease has expired. 0 when none.
   */
  oldestEligibleJobSeconds: number;
  /** Jobs that finished in the window, by outcome. */
  finishedJobs: number;
  succeededJobs: number;
  /** Failed with `VALIDATION_FAILED`: the provider's output did not pass validation. */
  invalidOutputJobs: number;
  /** Failed for a provider or worker reason (`PROVIDER_*`, `LEASE_EXPIRED`). */
  providerFailedJobs: number;
  /** Tokens and cost of jobs that finished in the window. */
  windowInputTokens: number;
  windowOutputTokens: number;
  windowCostMicros: number;
  /** Spend this calendar month, and the configured monthly cap (section 25). */
  monthSpendMicros: number;
  monthSpendCapMicros: number;
}

/**
 * AI job statistics for the worker's alert evaluator. AI owns `ai_job`, so other modules read it
 * through this service (AGENTS.md: modules own their tables). Ages, window totals and the month's
 * spend are relative to `at`, so a synthetic evaluation can look at a past window; the queued and
 * running counts are the current queue. One aggregate scan of `ai_job` per evaluation (jobs are
 * capped at 20 per user per day, section 25).
 */
@Injectable()
export class AiOperationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
  ) {}

  async stats(at: Date, windowMinutes: number): Promise<AiOperationalStats> {
    const [row] = await this.db.query<Record<string, string | number | null>>(
      `SELECT
         count(*) FILTER (WHERE state = 'queued')::int AS queued,
         count(*) FILTER (WHERE state = 'running')::int AS running,
         coalesce(extract(epoch FROM $1::timestamptz - least(
           min(available_at) FILTER (WHERE state = 'queued' AND available_at <= $1::timestamptz),
           min(lease_until) FILTER (WHERE state = 'running' AND lease_until < $1::timestamptz)
         )), 0)::float8 AS oldest_eligible_seconds,
         count(*) FILTER (WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
                            AND finished_at <= $1::timestamptz)::int AS finished,
         count(*) FILTER (WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
                            AND finished_at <= $1::timestamptz
                            AND state = 'succeeded')::int AS succeeded,
         count(*) FILTER (WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
                            AND finished_at <= $1::timestamptz
                            AND error_code = 'VALIDATION_FAILED')::int AS invalid_output,
         count(*) FILTER (WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
                            AND finished_at <= $1::timestamptz
                            AND error_code = ANY($3::text[]))::int AS provider_failed,
         coalesce(sum(input_tokens) FILTER (
           WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
             AND finished_at <= $1::timestamptz), 0)::bigint::text AS input_tokens,
         coalesce(sum(output_tokens) FILTER (
           WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
             AND finished_at <= $1::timestamptz), 0)::bigint::text AS output_tokens,
         coalesce(sum(cost_micros) FILTER (
           WHERE finished_at > $1::timestamptz - make_interval(mins => $2)
             AND finished_at <= $1::timestamptz), 0)::text AS window_cost,
         coalesce(sum(cost_micros) FILTER (
           WHERE created_at >= date_trunc('month', $1::timestamptz)
             AND created_at <= $1::timestamptz), 0)::text AS month_spend
       FROM ai_job`,
      {
        bind: [at.toISOString(), windowMinutes, PROVIDER_FAILURES],
        type: QueryTypes.SELECT,
      },
    );
    return {
      queuedJobs: Number(row?.queued ?? 0),
      runningJobs: Number(row?.running ?? 0),
      oldestEligibleJobSeconds: Math.max(0, Math.round(Number(row?.oldest_eligible_seconds ?? 0))),
      finishedJobs: Number(row?.finished ?? 0),
      succeededJobs: Number(row?.succeeded ?? 0),
      invalidOutputJobs: Number(row?.invalid_output ?? 0),
      providerFailedJobs: Number(row?.provider_failed ?? 0),
      windowInputTokens: Number(row?.input_tokens ?? 0),
      windowOutputTokens: Number(row?.output_tokens ?? 0),
      windowCostMicros: Number(row?.window_cost ?? 0),
      monthSpendMicros: Number(row?.month_spend ?? 0),
      monthSpendCapMicros: this.runtime.monthlySpendCapMicros,
    };
  }
}
