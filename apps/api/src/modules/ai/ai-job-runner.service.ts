import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiCapability, AiJobErrorCode } from '@bible-artisan/contracts';
import { fn, literal, QueryTypes, Transaction } from 'sequelize';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { AiJob } from '../../database/models/ai-job.model';
import { AiResult } from '../../database/models/ai-result.model';
import { ContextManifest } from '../../database/models/context-manifest.model';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { AiAccessService } from './ai-access.service';
import { AiSuggestionsService } from './ai-suggestions.service';
import { AiSummaryService } from './ai-summary.service';
import {
  INSIGHT_INPUT_BUDGET,
  INSIGHT_OUTPUT_TOKENS,
  INSIGHT_SAFETY_RESERVE,
  insightPrompt,
  parsePassagesOutput,
  PASSAGES_PROMPT_VERSION,
  PASSAGES_SCHEMA_VERSION,
  PASSAGES_SYSTEM_PROMPT,
  QUESTIONS_PROMPT_VERSION,
  QUESTIONS_SCHEMA_VERSION,
  QUESTIONS_SYSTEM_PROMPT,
  resolvePassages,
  TENSIONS_PROMPT_VERSION,
  TENSIONS_SCHEMA_VERSION,
  TENSIONS_SYSTEM_PROMPT,
  validateQuestionsOutput,
  validateTensionsOutput,
} from './capabilities/insights.capability';
import { OutputValidationError, REPAIR_INSTRUCTION } from './capabilities/output-validation';
import {
  RELATIONSHIPS_INPUT_BUDGET,
  RELATIONSHIPS_OUTPUT_TOKENS,
  RELATIONSHIPS_PROMPT_VERSION,
  RELATIONSHIPS_SAFETY_RESERVE,
  RELATIONSHIPS_SCHEMA_VERSION,
  RELATIONSHIPS_SCRIPTURE_CHARS,
  RELATIONSHIPS_SYSTEM_PROMPT,
  relationshipsPrompt,
  validateRelationshipsOutput,
} from './capabilities/relationships.capability';
import {
  SUMMARY_INPUT_BUDGET,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SAFETY_RESERVE,
  SUMMARY_SCHEMA_VERSION,
  SUMMARY_SYSTEM_PROMPT,
  summaryPrompt,
  validateSummaryOutput,
} from './capabilities/summary.capability';
import { studyIndex } from './capabilities/study-index';
import {
  type AssembledContext,
  assembleContext,
  type ContextCandidate,
  ContextBudgetExceededError,
  RETRIEVAL_RULES_VERSION,
} from './context/assemble-context';
import { ContextCandidatesService, type StudyContext } from './context/context-candidates.service';
import {
  AI_PROVIDER,
  AI_RUNTIME,
  type AiProvider,
  AiProviderError,
  type AiProviderResponse,
  type AiRuntime,
} from './provider/ai-provider';
import { estimateTokens } from './provider/fake-ai.provider';

/** PRD section 25: a crashed job is reclaimed after its lease; after this many claims it fails. */
export const MAX_JOB_ATTEMPTS = 3;
/** Provider calls per claim: the first try plus at most two retries (section 25). */
const MAX_PROVIDER_TRIES = 3;

interface ClaimedJob {
  id: string;
  ownerId: string;
  studyId: string;
  capability: AiCapability;
  input: Record<string, unknown>;
  consentVersion: string;
  leaseToken: string;
  attemptCount: number;
}

type Outcome =
  | { state: 'succeeded' }
  | { state: 'failed' | 'cancelled'; errorCode: AiJobErrorCode }
  /** The job is no longer ours (cancelled elsewhere, lease lost): write nothing. */
  | { state: 'abandoned' };

/**
 * The worker side of AI jobs (BIB-39, PRD section 25): claims one job at a time with a lease
 * (`FOR UPDATE SKIP LOCKED`, one running job per study and two per user), assembles a bounded
 * context, calls the provider outside any transaction, validates the output and publishes it.
 *
 * - The lease (two minutes) is renewed while the call runs; a renewal that finds the job cancelled
 *   or no longer ours aborts the provider call. A crashed worker's job is reclaimed when its lease
 *   expires, and fails `LEASE_EXPIRED` after `MAX_JOB_ATTEMPTS` claims.
 * - Consent and the study switch are checked before the provider is called and again, under the
 *   user row lock, before the result is published: a revoked consent discards the output.
 * - Transient provider errors are retried at most twice with jitter inside the 60-second budget,
 *   respecting Retry-After. Failures end the job with a fixed error code; study data is never
 *   touched, so deterministic editing is unaffected (FR-AI-012).
 * - Logs carry the job id, state, error code, attempt, counts and latency only: never prompt or
 *   response text (NFR-PRIV-001).
 */
@Injectable()
export class AiJobRunnerService {
  private readonly logger = new Logger('AiJobRunner');
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider | null,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    private readonly access: AiAccessService,
    private readonly candidates: ContextCandidatesService,
    private readonly suggestions: AiSuggestionsService,
    private readonly summaries: AiSummaryService,
    private readonly references: ReferenceService,
  ) {}

  /** Starts polling (the worker). Returns a function that stops it. */
  start(): () => void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      try {
        await this.summaries.scheduleAutomatic();
        while (!this.stopped && (await this.runOnce()) !== null) {
          // Drain the queue, then wait for the next poll.
        }
      } catch (error) {
        this.logger.error('ai_job_poll_failed', {
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.runtime.pollMs);
    };
    void tick();
    return () => {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /** Claims and runs one job. Returns its id, or null when no job is ready. */
  async runOnce(): Promise<string | null> {
    const job = await this.claim();
    if (!job) return null;
    const started = Date.now();
    let outcome: Outcome;
    let usage: AiProviderResponse | null = null;
    try {
      const run = await this.process(job);
      outcome = run.outcome;
      usage = run.usage;
    } catch (error) {
      this.logger.error('ai_job_crashed', {
        jobId: job.id,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      outcome = { state: 'failed', errorCode: 'PROVIDER_ERROR' };
    }
    if (outcome.state === 'failed' || outcome.state === 'cancelled') {
      await this.finish(job, outcome.state, outcome.errorCode, usage);
    }
    this.logger.log('ai_job_finished', {
      jobId: job.id,
      state: outcome.state,
      errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
      attempt: job.attemptCount,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      latencyMs: Date.now() - started,
    });
    return job.id;
  }

  /**
   * One short transaction: fail jobs whose lease expired too many times, then lease the oldest
   * ready job whose study has no running job and whose owner has fewer than two. A transaction-
   * level advisory lock serializes claims, so those two limits hold across workers.
   */
  private async claim(): Promise<ClaimedJob | null> {
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        await this.db.query(`SELECT pg_advisory_xact_lock(hashtext('ai_job_claim'))`, {
          type: QueryTypes.SELECT,
          transaction,
        });
        await this.db.query(
          `UPDATE ai_job
              SET state = 'failed', error_code = 'LEASE_EXPIRED', lease_until = NULL,
                  lease_token = NULL, finished_at = now(), updated_at = now()
            WHERE state = 'running' AND lease_until < now() AND attempt_count >= $1`,
          { bind: [MAX_JOB_ATTEMPTS], type: QueryTypes.UPDATE, transaction },
        );
        const rows = await this.db.query<{
          id: string;
          owner_id: string;
          study_id: string;
          consent_version: string;
          lease_token: string;
          attempt_count: number;
          capability: AiCapability;
          input: Record<string, unknown>;
        }>(
          `UPDATE ai_job j
              SET state = 'running', lease_token = gen_random_uuid(),
                  lease_until = now() + make_interval(secs => $1::double precision / 1000),
                  attempt_count = j.attempt_count + 1,
                  started_at = coalesce(j.started_at, now()), updated_at = now()
            WHERE j.id = (
              SELECT c.id FROM ai_job c
               WHERE ((c.state = 'queued' AND c.available_at <= now())
                      OR (c.state = 'running' AND c.lease_until < now()))
                 AND NOT EXISTS (
                   SELECT 1 FROM ai_job r
                    WHERE r.study_id = c.study_id AND r.id <> c.id
                      AND r.state = 'running' AND r.lease_until >= now())
                 AND (SELECT count(*) FROM ai_job r
                       WHERE r.owner_id = c.owner_id AND r.id <> c.id
                         AND r.state = 'running' AND r.lease_until >= now()) < $2
               ORDER BY c.available_at, c.created_at, c.id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
            RETURNING j.id, j.owner_id, j.study_id, j.consent_version, j.lease_token,
                      j.attempt_count, j.capability, j.input`,
          { bind: [this.runtime.leaseMs, 2], type: QueryTypes.SELECT, transaction },
        );
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          ownerId: row.owner_id,
          studyId: row.study_id,
          consentVersion: row.consent_version,
          leaseToken: row.lease_token,
          attemptCount: row.attempt_count,
          capability: row.capability,
          input: row.input,
        };
      },
    );
  }

  private async process(
    job: ClaimedJob,
  ): Promise<{ outcome: Outcome; usage: AiProviderResponse | null }> {
    const provider = this.provider;
    if (provider === null) {
      return { outcome: { state: 'failed', errorCode: 'AI_UNAVAILABLE' }, usage: null };
    }
    const blocker = await this.access.jobBlocker(job);
    if (blocker !== null) {
      return {
        outcome: {
          state: blocker === 'AI_UNAVAILABLE' ? 'failed' : 'cancelled',
          errorCode: blocker,
        },
        usage: null,
      };
    }
    if (await this.overSpendCap()) {
      return { outcome: { state: 'failed', errorCode: 'SPEND_CAP_REACHED' }, usage: null };
    }

    let plan: CapabilityPlan | null;
    try {
      plan = await this.plan(job);
    } catch {
      // The study left the owner's reach (purged, past its window) after the request.
      plan = null;
    }
    if (plan === null) {
      return { outcome: { state: 'cancelled', errorCode: 'STUDY_UNAVAILABLE' }, usage: null };
    }

    const heartbeat = new AbortController();
    const timer = setInterval(() => {
      void this.renewLease(job).then((held) => {
        if (!held) heartbeat.abort();
      });
    }, this.runtime.heartbeatMs);
    const deadline = Date.now() + this.runtime.requestBudgetMs;
    const limit = plan.inputBudget - plan.safetyReserve;
    try {
      const contextBudget = limit - estimateTokens(plan.system);
      let context: AssembledContext;
      let measured: number;
      try {
        context = assembleContext(plan.candidates, plan.capped, contextBudget, estimateTokens);
        measured = await this.measure(provider, plan, context, heartbeat.signal, deadline);
        if (measured > limit) {
          // The provider's tokenizer counts more than the estimate: shrink once, proportionally.
          const scaled = Math.floor((contextBudget * limit) / measured);
          context = assembleContext(plan.candidates, plan.capped, scaled, estimateTokens);
          measured = await this.measure(provider, plan, context, heartbeat.signal, deadline);
          if (measured > limit) throw new ContextBudgetExceededError();
        }
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) {
          return {
            outcome: { state: 'failed', errorCode: 'CONTEXT_BUDGET_EXCEEDED' },
            usage: null,
          };
        }
        if (error instanceof AiProviderError) {
          return { outcome: this.providerOutcome(error, heartbeat.signal), usage: null };
        }
        throw error;
      }

      await this.saveManifest(job, plan, context, measured);

      // BIB-41: validate; one constrained repair (same context and trust rules) for output that
      // is not JSON or not the schema; then fail closed. Invented ids are never repaired.
      const prompt = plan.prompt(context.blocks);
      let usage: AiProviderResponse | null = null;
      let validated: unknown;
      for (let round = 0; ; round += 1) {
        let response: AiProviderResponse;
        try {
          response = await this.callWithRetries(
            provider,
            plan,
            round === 0 ? prompt : `${prompt}\n\n${REPAIR_INSTRUCTION}`,
            heartbeat.signal,
            deadline,
          );
        } catch (error) {
          if (error instanceof AiProviderError) {
            return { outcome: this.providerOutcome(error, heartbeat.signal), usage };
          }
          throw error;
        }
        usage = addUsage(usage, response);
        try {
          validated = await plan.validate(response.text, context);
          break;
        } catch (error) {
          if (!(error instanceof OutputValidationError)) throw error;
          if (round === 0 && error.repairable) {
            this.logger.log('ai_job_output_repair', { jobId: job.id, reason: error.reason });
            continue;
          }
          this.logger.log('ai_job_output_rejected', { jobId: job.id, reason: error.reason });
          return { outcome: { state: 'failed', errorCode: 'VALIDATION_FAILED' }, usage };
        }
      }

      const published = await this.publish(job, provider, plan, validated, usage);
      return { outcome: published, usage };
    } finally {
      clearInterval(timer);
    }
  }

  /** What the job's capability reads, asks and validates (BIB-42 adds `relationships`). */
  private async plan(job: ClaimedJob): Promise<CapabilityPlan | null> {
    if (job.capability === 'relationships') {
      const sourceNodeId = typeof job.input.sourceNodeId === 'string' ? job.input.sourceNodeId : '';
      const targetNodeId = typeof job.input.targetNodeId === 'string' ? job.input.targetNodeId : '';
      const gathered = await this.candidates.gatherPair(
        job.ownerId,
        job.studyId,
        sourceNodeId,
        targetNodeId,
        RELATIONSHIPS_SCRIPTURE_CHARS,
      );
      const pair = gathered.pair;
      if (pair === null) return null;
      return {
        system: RELATIONSHIPS_SYSTEM_PROMPT,
        inputBudget: RELATIONSHIPS_INPUT_BUDGET,
        outputTokens: RELATIONSHIPS_OUTPUT_TOKENS,
        safetyReserve: RELATIONSHIPS_SAFETY_RESERVE,
        promptVersion: RELATIONSHIPS_PROMPT_VERSION,
        schemaVersion: RELATIONSHIPS_SCHEMA_VERSION,
        contentRevision: gathered.contentRevision,
        candidates: gathered.candidates,
        capped: gathered.capped,
        prompt: (blocks) => relationshipsPrompt(blocks, sourceNodeId, targetNodeId),
        validate: (text, context) =>
          validateRelationshipsOutput(text, {
            manifest: new Map(context.entries.map((entry) => [entry.id, entry.kind])),
            pair,
            quotable: gathered.quotable,
          }),
        store: (transaction, scope, validated) =>
          this.suggestions.storeProposals(transaction, scope, {
            ...(validated as ReturnType<typeof validateRelationshipsOutput>),
            pair,
            regenerate: job.input.regenerate === true,
          }),
      };
    }
    const gathered = await this.candidates.gather(job.ownerId, job.studyId);
    const regenerate = job.input.regenerate === true;
    const common = {
      contentRevision: gathered.contentRevision,
      candidates: gathered.candidates,
      capped: gathered.capped,
    };
    const insight = {
      ...common,
      inputBudget: INSIGHT_INPUT_BUDGET,
      outputTokens: INSIGHT_OUTPUT_TOKENS,
      safetyReserve: INSIGHT_SAFETY_RESERVE,
    };
    switch (job.capability) {
      case 'tensions':
        return {
          ...insight,
          system: TENSIONS_SYSTEM_PROMPT,
          promptVersion: TENSIONS_PROMPT_VERSION,
          schemaVersion: TENSIONS_SCHEMA_VERSION,
          prompt: (blocks) => insightPrompt('tensions', blocks),
          validate: (text, context) => validateTensionsOutput(text, studyIndex(gathered, context)),
          store: (transaction, scope, validated) =>
            this.suggestions.storeTensions(transaction, scope, {
              ...(validated as ReturnType<typeof validateTensionsOutput>),
              regenerate,
            }),
        };
      case 'questions':
        return {
          ...insight,
          system: QUESTIONS_SYSTEM_PROMPT,
          promptVersion: QUESTIONS_PROMPT_VERSION,
          schemaVersion: QUESTIONS_SCHEMA_VERSION,
          prompt: (blocks) => insightPrompt('questions', blocks),
          validate: (text, context) => validateQuestionsOutput(text, studyIndex(gathered, context)),
          store: (transaction, scope, validated) =>
            this.suggestions.storeQuestions(transaction, scope, {
              ...(validated as ReturnType<typeof validateQuestionsOutput>),
              regenerate,
            }),
        };
      case 'passages':
        return {
          ...insight,
          system: PASSAGES_SYSTEM_PROMPT,
          promptVersion: PASSAGES_PROMPT_VERSION,
          schemaVersion: PASSAGES_SCHEMA_VERSION,
          prompt: (blocks) => insightPrompt('passages', blocks),
          validate: (text) => this.validatePassages(text, gathered),
          store: (transaction, scope, validated) =>
            this.suggestions.storePassages(transaction, scope, {
              ...(validated as Awaited<ReturnType<AiJobRunnerService['validatePassages']>>),
              regenerate,
            }),
        };
      default:
        return {
          ...common,
          system: SUMMARY_SYSTEM_PROMPT,
          inputBudget: SUMMARY_INPUT_BUDGET,
          outputTokens: SUMMARY_OUTPUT_TOKENS,
          safetyReserve: SUMMARY_SAFETY_RESERVE,
          promptVersion: SUMMARY_PROMPT_VERSION,
          schemaVersion: SUMMARY_SCHEMA_VERSION,
          prompt: summaryPrompt,
          validate: (text, context) => ({
            valid: validateSummaryOutput(text, studyIndex(gathered, context)),
            coverageWarnings: context.coverageWarnings,
          }),
          store: (transaction, scope, validated) =>
            this.summaries.store(transaction, scope, {
              ...(validated as {
                valid: ReturnType<typeof validateSummaryOutput>;
                coverageWarnings: string[];
              }),
              gathered,
            }),
        };
    }
  }

  /**
   * BIB-45: passages a user may see. Every model reference is resolved against the local corpus
   * of the study's edition (its starting passage's, else a Scripture node's, else the first active
   * edition); anything that does not resolve to exactly one range, or that the study already
   * holds, is excluded before display.
   */
  private async validatePassages(text: string, gathered: StudyContext) {
    const parsed = parsePassagesOutput(text);
    const startingEdition = gathered.startingReferenceId
      ? gathered.references.get(gathered.startingReferenceId)?.editionId
      : undefined;
    const nodeEdition = gathered.nodes
      .map((node) => (node.referenceId ? gathered.references.get(node.referenceId) : undefined))
      .find((ref) => ref !== undefined)?.editionId;
    const editionId = startingEdition ?? nodeEdition ?? (await this.references.defaultEditionId());
    const held = new Set(
      gathered.nodes.flatMap((node) => (node.referenceId ? [node.referenceId] : [])),
    );
    const resolved = await resolvePassages(
      parsed.candidates,
      (reference) =>
        editionId ? this.references.resolveExact(editionId, reference) : Promise.resolve(null),
      held,
    );
    return { proposals: resolved.proposals, dropped: parsed.dropped + resolved.dropped };
  }

  private measure(
    provider: AiProvider,
    plan: CapabilityPlan,
    context: AssembledContext,
    cancel: AbortSignal,
    deadline: number,
  ): Promise<number> {
    return provider.countTokens({
      system: plan.system,
      prompt: plan.prompt(context.blocks),
      signal: AbortSignal.any([cancel, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
    });
  }

  /** At most `MAX_PROVIDER_TRIES` calls inside the request budget, with jittered backoff. */
  private async callWithRetries(
    provider: AiProvider,
    plan: CapabilityPlan,
    prompt: string,
    cancel: AbortSignal,
    deadline: number,
  ): Promise<AiProviderResponse> {
    for (let attempt = 1; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AiProviderError('timeout');
      const timeout = AbortSignal.timeout(remaining);
      try {
        return await provider.generate({
          system: plan.system,
          prompt,
          maxOutputTokens: plan.outputTokens,
          signal: AbortSignal.any([cancel, timeout]),
        });
      } catch (error) {
        if (!(error instanceof AiProviderError)) throw error;
        if (error.kind === 'aborted' && timeout.aborted && !cancel.aborted) {
          throw new AiProviderError('timeout');
        }
        const retryable = error.kind === 'transient' || error.kind === 'timeout';
        if (!retryable || attempt >= MAX_PROVIDER_TRIES) throw error;
        const backoff =
          error.retryAfterMs ??
          this.runtime.retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
        if (Date.now() + backoff >= deadline) throw error;
        await sleep(backoff, cancel);
        if (cancel.aborted) throw new AiProviderError('aborted');
      }
    }
  }

  private providerOutcome(error: AiProviderError, cancel: AbortSignal): Outcome {
    if (cancel.aborted) return { state: 'abandoned' };
    switch (error.kind) {
      case 'timeout':
      case 'aborted':
        return { state: 'failed', errorCode: 'PROVIDER_TIMEOUT' };
      case 'transient':
        return { state: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' };
      case 'refused':
        return { state: 'failed', errorCode: 'PROVIDER_REFUSED' };
      default:
        return { state: 'failed', errorCode: 'PROVIDER_ERROR' };
    }
  }

  private async renewLease(job: ClaimedJob): Promise<boolean> {
    try {
      const [affected] = await AiJob.update(
        {
          leaseUntil: literal(
            `now() + make_interval(secs => ${Number(this.runtime.leaseMs) / 1000})`,
          ),
          updatedAt: fn('now'),
        },
        { where: { id: job.id, leaseToken: job.leaseToken, state: 'running' } },
      );
      return affected === 1;
    } catch {
      // A failed renewal is not a lost lease; the next renewal tries again.
      return true;
    }
  }

  private async saveManifest(
    job: ClaimedJob,
    plan: CapabilityPlan,
    context: AssembledContext,
    measured: number,
  ): Promise<void> {
    const scope = { ownerId: job.ownerId, studyId: job.studyId, jobId: job.id };
    await this.db.transaction(async () => {
      // A reclaimed job replaces the manifest of its crashed attempt.
      await ContextManifest.destroy({ where: scope });
      await ContextManifest.create({
        ...scope,
        retrievalRulesVersion: RETRIEVAL_RULES_VERSION,
        tokenBudget: plan.inputBudget,
        tokenCount: measured,
        entries: context.entries,
        omissions: context.omissions,
        coverageWarnings: context.coverageWarnings,
      });
    });
  }

  /**
   * Publishes the result in one transaction, only if the job is still ours and running, and the
   * consent and study switch still allow it (checked under the user row lock, so a revocation
   * that commits first wins and the output is discarded).
   */
  private async publish(
    job: ClaimedJob,
    provider: AiProvider,
    plan: CapabilityPlan,
    validated: unknown,
    response: AiProviderResponse,
  ): Promise<Outcome> {
    const basisRevision = plan.contentRevision;
    return this.db.transaction(async (transaction) => {
      const blocker = await this.access.jobBlocker(job, transaction);
      const current = await AiJob.findOne({
        where: { id: job.id, leaseToken: job.leaseToken, state: 'running' },
        lock: Transaction.LOCK.UPDATE,
        transaction,
      });
      if (!current) return { state: 'abandoned' } as const;
      if (blocker !== null) {
        await this.finishIn(transaction, job, 'cancelled', blocker, response, provider);
        return { state: 'abandoned' } as const;
      }
      const output = await plan.store(
        transaction,
        {
          jobId: job.id,
          ownerId: job.ownerId,
          studyId: job.studyId,
          basisRevision,
          modelId: provider.modelId,
          promptVersion: plan.promptVersion,
        },
        validated,
      );
      await AiResult.create(
        {
          jobId: job.id,
          ownerId: job.ownerId,
          studyId: job.studyId,
          capability: job.capability,
          basisRevision,
          modelId: provider.modelId,
          promptVersion: plan.promptVersion,
          schemaVersion: plan.schemaVersion,
          outputJson: output,
        },
        { transaction },
      );
      await AiJob.update(
        {
          state: 'succeeded',
          basisRevision,
          modelId: provider.modelId,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costMicros: String(provider.costMicros(response.inputTokens, response.outputTokens)),
          leaseUntil: null,
          leaseToken: null,
          finishedAt: fn('now'),
          updatedAt: fn('now'),
        },
        { where: { id: job.id }, transaction },
      );
      return { state: 'succeeded' } as const;
    });
  }

  private async finish(
    job: ClaimedJob,
    state: 'failed' | 'cancelled',
    errorCode: AiJobErrorCode,
    usage: AiProviderResponse | null,
  ): Promise<void> {
    await this.db.transaction((transaction) =>
      this.finishIn(transaction, job, state, errorCode, usage, this.provider),
    );
  }

  /** Ends a job we still hold; a job cancelled or reclaimed meanwhile is left as it is. */
  private async finishIn(
    transaction: Transaction,
    job: ClaimedJob,
    state: 'failed' | 'cancelled',
    errorCode: AiJobErrorCode,
    usage: AiProviderResponse | null,
    provider: AiProvider | null,
  ): Promise<void> {
    await AiJob.update(
      {
        state,
        errorCode,
        leaseUntil: null,
        leaseToken: null,
        finishedAt: fn('now'),
        updatedAt: fn('now'),
        ...(usage && provider
          ? {
              modelId: provider.modelId,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costMicros: String(provider.costMicros(usage.inputTokens, usage.outputTokens)),
            }
          : {}),
      },
      { where: { id: job.id, leaseToken: job.leaseToken, state: 'running' }, transaction },
    );
  }

  private async overSpendCap(): Promise<boolean> {
    const [row] = await this.db.query<{ spent: string }>(
      `SELECT coalesce(sum(cost_micros), 0)::text AS spent FROM ai_job
        WHERE created_at >= date_trunc('month', now())`,
      { type: QueryTypes.SELECT },
    );
    return Number(row?.spent ?? 0) >= this.runtime.monthlySpendCapMicros;
  }
}

/** Where a capability publishes, inside the publishing transaction. */
export interface PublishScope {
  jobId: string;
  ownerId: string;
  studyId: string;
  basisRevision: number;
  modelId: string;
  promptVersion: string;
}

/** One capability's budget, prompt, validation and publication (summary, relationships). */
interface CapabilityPlan {
  system: string;
  inputBudget: number;
  outputTokens: number;
  safetyReserve: number;
  promptVersion: string;
  schemaVersion: string;
  contentRevision: number;
  candidates: ContextCandidate[];
  capped: ContextCandidate[];
  prompt: (blocks: readonly string[]) => string;
  /** Throws `OutputValidationError`; returns (or resolves to) what `store` publishes. */
  validate: (text: string, context: AssembledContext) => unknown;
  /** Writes capability rows (suggestions) and returns the AiResult output. */
  store: (
    transaction: Transaction,
    scope: PublishScope,
    validated: unknown,
  ) => Promise<Record<string, unknown>>;
}

/** Token usage summed over a call and its repair. */
function addUsage(total: AiProviderResponse | null, next: AiProviderResponse): AiProviderResponse {
  if (total === null) return next;
  return {
    text: next.text,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
