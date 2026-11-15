import { Inject, Injectable } from '@nestjs/common';
import {
  AI_CONSENT_VERSION,
  AI_LIMITS,
  AI_QUOTA_EXCEEDED,
  AI_SPEND_CAP_REACHED,
  type AiCapability,
  type AiJobAcceptedResponse,
  type AiJobErrorCode,
  type AiJobResponse,
  RETRYABLE_AI_JOB_ERRORS,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { fn, QueryTypes, type Transaction } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AiQuotaError,
  IdempotencyKeyReusedError,
  NotFoundError,
  StudyLifecycleError,
} from '../../common/errors/domain-errors';
import { isResourceId } from '../../common/validation/resource-id';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { AiJob } from '../../database/models/ai-job.model';
import { AiResult } from '../../database/models/ai-result.model';
import { ContextManifest } from '../../database/models/context-manifest.model';
import { StudyAccessService } from '../study/study-access.service';
import { AiAccessService } from './ai-access.service';
import { AI_RUNTIME, type AiRuntime } from './provider/ai-provider';

const ACTIVE_STATES = ['queued', 'running'] as const;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
/** PRD section 17: "Manual regenerate is allowed once per ten seconds". */
const SUMMARY_REGENERATE_SECONDS = 10;

/**
 * AI job requests, status and cancellation (BIB-39, PRD sections 24, 25). Requests only record a
 * job: no provider call happens here, so a request (and every core edit) returns at once and the
 * worker does the work. Every lookup is owner-scoped from the session; another user's job and an
 * absent one are the same 404.
 */
@Injectable()
export class AiJobsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    private readonly studies: StudyAccessService,
    private readonly access: AiAccessService,
  ) {}

  /**
   * `POST /studies/:id/ai/<capability>` → 202. In order: the study (404; a trashed study is 422),
   * the AI gates (503 / 422), then, serialized per owner by an advisory lock so limits are exact:
   * the Idempotency-Key (same key replays its job; a key used for another study or capability is
   * 422), coalescing (an equivalent waiting or running job is returned as `existing` without
   * spending a request), the rolling limits and the monthly spend cap (429 with Retry-After).
   */
  async request(
    ownerId: string,
    studyId: string,
    capability: AiCapability,
    idempotencyKey: string | null,
    /** The capability's parameters (ids and flags only); part of what makes jobs equivalent. */
    input: Record<string, unknown> = {},
  ): Promise<AiJobAcceptedResponse> {
    const study = await this.studies.requireOwnedStudy(ownerId, studyId);
    if (study.lifecycle === 'trashed') throw new StudyLifecycleError(STUDY_TRASHED);
    await this.access.assertRequestAllowed(ownerId, studyId);

    return this.db.transaction(async (transaction) => {
      await this.db.query(`SELECT pg_advisory_xact_lock(hashtext('ai_job_request:' || $1))`, {
        bind: [ownerId],
        type: QueryTypes.SELECT,
        transaction,
      });
      if (idempotencyKey !== null) {
        const keyed = await AiJob.findOne({
          where: { ownerId, requestKey: `key:${idempotencyKey}` },
          transaction,
        });
        if (keyed) {
          if (
            keyed.studyId !== studyId ||
            keyed.capability !== capability ||
            !isDeepStrictEqual(keyed.input, input)
          ) {
            throw new IdempotencyKeyReusedError();
          }
          return accepted(keyed, 'existing');
        }
      }
      const active = (
        await AiJob.findAll({
          where: { ownerId, studyId, capability, state: [...ACTIVE_STATES] },
          order: [['createdAt', 'ASC']],
          transaction,
        })
      ).find((job) => isDeepStrictEqual(job.input, input));
      if (active) return accepted(active, 'existing');

      if (capability === 'summary') await this.checkRegenerateInterval(ownerId, studyId);
      await this.checkLimits(ownerId, transaction);
      const job = await AiJob.create(
        {
          ownerId,
          studyId,
          capability,
          trigger: 'user',
          requestKey: idempotencyKey !== null ? `key:${idempotencyKey}` : `auto:${randomUUID()}`,
          input,
          basisRevision: study.contentRevision,
          consentVersion: AI_CONSENT_VERSION,
        },
        { transaction },
      );
      return accepted(job, 'queued');
    });
  }

  /**
   * An automatic summary job (BIB-43, PRD section 17), queued by the worker's debounce. Never
   * throws for a gate: returns false when AI is not allowed for the study, an equivalent job is
   * already waiting or running, or the automatic daily limit or the spend cap is reached.
   */
  async requestAutomaticSummary(
    ownerId: string,
    studyId: string,
    basisRevision: number,
  ): Promise<boolean> {
    try {
      await this.access.assertRequestAllowed(ownerId, studyId);
    } catch {
      return false;
    }
    return this.db.transaction(async (transaction) => {
      await this.db.query(`SELECT pg_advisory_xact_lock(hashtext('ai_job_request:' || $1))`, {
        bind: [ownerId],
        type: QueryTypes.SELECT,
        transaction,
      });
      const active = await AiJob.count({
        where: { ownerId, studyId, capability: 'summary', state: [...ACTIVE_STATES] },
        transaction,
      });
      if (active > 0) return false;
      const [row] = await this.db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ai_job
          WHERE owner_id = $1 AND trigger = 'automatic'
            AND created_at > now() - make_interval(secs => $2)`,
        { bind: [ownerId, DAY_SECONDS], type: QueryTypes.SELECT, transaction },
      );
      if ((row?.count ?? 0) >= AI_LIMITS.automaticSummariesPerDay) return false;
      try {
        await this.checkLimits(ownerId, transaction);
      } catch (error) {
        if (error instanceof AiQuotaError) return false;
        throw error;
      }
      await AiJob.create(
        {
          ownerId,
          studyId,
          capability: 'summary',
          trigger: 'automatic',
          requestKey: `auto:${randomUUID()}`,
          input: {},
          basisRevision,
          consentVersion: AI_CONSENT_VERSION,
        },
        { transaction },
      );
      return true;
    });
  }

  /** Requests left in the rolling windows, for the consent settings screen. */
  async remaining(ownerId: string): Promise<{ thisHour: number; today: number }> {
    const hour = await this.countSince(ownerId, HOUR_SECONDS, true);
    const day = await this.countSince(ownerId, DAY_SECONDS, false);
    return {
      thisHour: Math.max(0, AI_LIMITS.userRequestsPerHour - hour.count),
      today: Math.max(0, AI_LIMITS.requestsPerDay - day.count),
    };
  }

  /** `GET /studies/:id/ai/jobs/:jobId`: state, freshness basis, context summary and result. */
  async get(ownerId: string, studyId: string, jobId: string): Promise<AiJobResponse> {
    const study = await this.studies.requireOwnedStudy(ownerId, studyId);
    if (!isResourceId(jobId)) throw new NotFoundError();
    const job = await AiJob.findOne({ where: { id: jobId, studyId, ownerId } });
    if (!job) throw new NotFoundError();
    const scope = { ownerId, studyId, jobId: job.id };
    const manifest = await ContextManifest.findOne({ where: scope });
    const result = job.state === 'succeeded' ? await AiResult.findOne({ where: scope }) : null;
    return {
      jobId: job.id,
      studyId: job.studyId,
      capability: job.capability,
      state: job.state,
      basisRevision: job.basisRevision,
      currentRevision: study.contentRevision,
      stale: job.basisRevision < study.contentRevision,
      attemptCount: job.attemptCount,
      errorCode: job.errorCode,
      retryable: job.errorCode !== null && RETRYABLE_AI_JOB_ERRORS.has(job.errorCode),
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      context: manifest
        ? {
            tokenBudget: manifest.tokenBudget,
            tokenCount: manifest.tokenCount,
            includedCount: manifest.entries.length,
            omittedCount: manifest.omissions.length,
            coverageWarnings: manifest.coverageWarnings,
          }
        : null,
      result: result
        ? {
            id: result.id,
            modelId: result.modelId,
            promptVersion: result.promptVersion,
            output: result.outputJson as NonNullable<AiJobResponse['result']>['output'],
            createdAt: result.createdAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Cancels the owner's waiting and running jobs (all of them, or one study's) inside the
   * caller's transaction: consent revocation and the study switch (BIB-40). A running job's
   * worker notices at its next lease renewal or when it tries to publish, aborts the provider call
   * where it can and discards the output. Returns the number cancelled.
   */
  async cancelActive(
    scope: { ownerId: string; studyId?: string },
    reason: Extract<AiJobErrorCode, 'CONSENT_REVOKED' | 'AI_DISABLED_FOR_STUDY'>,
    transaction: Transaction,
  ): Promise<number> {
    const [affected] = await AiJob.update(
      {
        state: 'cancelled',
        errorCode: reason,
        leaseUntil: null,
        leaseToken: null,
        finishedAt: fn('now'),
        updatedAt: fn('now'),
      },
      {
        where: {
          ownerId: scope.ownerId,
          ...(scope.studyId ? { studyId: scope.studyId } : {}),
          state: [...ACTIVE_STATES],
        },
        transaction,
      },
    );
    return affected;
  }

  /**
   * One manual summary request per study per ten seconds (429 with Retry-After). A request after
   * a failed or cancelled one is a retry, not a regenerate, and is not held back.
   */
  private async checkRegenerateInterval(ownerId: string, studyId: string): Promise<void> {
    const [row] = await this.db.query<{ retry_after: number | null }>(
      `SELECT ceil(extract(epoch FROM max(created_at) + make_interval(secs => $3) - now()))::int
                AS retry_after
         FROM ai_job
        WHERE owner_id = $1 AND study_id = $2 AND capability = 'summary' AND trigger = 'user'
          AND state NOT IN ('failed', 'cancelled')
          AND created_at > now() - make_interval(secs => $3)`,
      { bind: [ownerId, studyId, SUMMARY_REGENERATE_SECONDS], type: QueryTypes.SELECT },
    );
    if (row?.retry_after != null) {
      throw new AiQuotaError(AI_QUOTA_EXCEEDED, Math.max(1, row.retry_after));
    }
  }

  /** The rolling request limits and the monthly spend cap (PRD section 25). */
  private async checkLimits(ownerId: string, transaction: Transaction): Promise<void> {
    const hour = await this.countSince(ownerId, HOUR_SECONDS, true, transaction);
    if (hour.count >= AI_LIMITS.userRequestsPerHour) {
      throw new AiQuotaError(AI_QUOTA_EXCEEDED, hour.retryAfterSeconds);
    }
    const day = await this.countSince(ownerId, DAY_SECONDS, false, transaction);
    if (day.count >= AI_LIMITS.requestsPerDay) {
      throw new AiQuotaError(AI_QUOTA_EXCEEDED, day.retryAfterSeconds);
    }
    const [spend] = await this.db.query<{ spent: string; until_next_month: number }>(
      `SELECT coalesce(sum(cost_micros), 0)::text AS spent,
              ceil(extract(epoch FROM date_trunc('month', now()) + interval '1 month' - now()))::int
                AS until_next_month
         FROM ai_job
        WHERE created_at >= date_trunc('month', now())`,
      { type: QueryTypes.SELECT, transaction },
    );
    if (spend && Number(spend.spent) >= this.runtime.monthlySpendCapMicros) {
      throw new AiQuotaError(AI_SPEND_CAP_REACHED, Math.max(1, spend.until_next_month));
    }
  }

  /** Jobs the owner requested in the last `seconds`, and when the oldest leaves the window. */
  private async countSince(
    ownerId: string,
    seconds: number,
    userOnly: boolean,
    transaction?: Transaction,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const [row] = await this.db.query<{ count: number; retry_after: number | null }>(
      `SELECT count(*)::int AS count,
              ceil(extract(epoch FROM min(created_at) + make_interval(secs => $2) - now()))::int
                AS retry_after
         FROM ai_job
        WHERE owner_id = $1
          AND created_at > now() - make_interval(secs => $2)
          AND ($3::boolean IS FALSE OR trigger = 'user')`,
      { bind: [ownerId, seconds, userOnly], type: QueryTypes.SELECT, transaction },
    );
    return { count: row?.count ?? 0, retryAfterSeconds: Math.max(1, row?.retry_after ?? 1) };
  }
}

function accepted(job: AiJob, outcome: 'queued' | 'existing'): AiJobAcceptedResponse {
  return {
    jobId: job.id,
    basisRevision: job.basisRevision,
    statusUrl: `/v1/studies/${job.studyId}/ai/jobs/${job.id}`,
    outcome,
  };
}
