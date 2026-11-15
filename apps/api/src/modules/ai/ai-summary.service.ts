import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RETRYABLE_AI_JOB_ERRORS,
  type StudySummaryResponse,
  type SummaryJobOutput,
} from '@bible-artisan/contracts';
import { randomUUID } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { AiJob } from '../../database/models/ai-job.model';
import { ContextManifest } from '../../database/models/context-manifest.model';
import { StudySummarySchedule } from '../../database/models/study-summary-schedule.model';
import { StudySummary } from '../../database/models/study-summary.model';
import { StudyAccessService } from '../study/study-access.service';
import { AiJobsService } from './ai-jobs.service';
import {
  buildStudySummary,
  SUMMARY_SCHEMA_VERSION,
  type ValidSummary,
} from './capabilities/summary.capability';
import type { StudyContext } from './context/context-candidates.service';
import {
  AI_RUNTIME,
  type AiRuntime,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_MAX_WAIT_MS,
} from './provider/ai-provider';

interface PublishScope {
  jobId: string;
  ownerId: string;
  studyId: string;
  basisRevision: number;
  modelId: string;
  promptVersion: string;
}

/**
 * The living study summary (BIB-43; PRD sections 16 "Study synthesis", 17, 24 `GET /summary`).
 *
 * - `store` (the worker, inside its publishing transaction): one immutable StudySummary v1
 *   revision. It becomes current only when its basis is still the study's content revision;
 *   otherwise it is kept as a historical artifact and never replaces the current summary.
 * - `get`: the current summary (or the latest valid one while none is current), with freshness:
 *   stale as soon as a committed content change moves the study past its basis. A failed or
 *   running generation never removes the last valid summary.
 * - `scheduleAutomatic` (the worker's tick): for studies that have a summary, a significant
 *   change (one that moves the content revision; passive visits, selection, layout and pane
 *   changes do not) queues one automatic summary 30 seconds after the last change, or at most two
 *   minutes after the first. While a summary job runs, later changes keep the study dirty and one
 *   follow-up is queued after it.
 */
@Injectable()
export class AiSummaryService {
  private readonly logger = new Logger('AiSummary');

  constructor(
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    private readonly access: StudyAccessService,
    private readonly jobs: AiJobsService,
  ) {}

  async store(
    transaction: Transaction,
    scope: PublishScope,
    input: { valid: ValidSummary; coverageWarnings: string[]; gathered: StudyContext },
  ): Promise<SummaryJobOutput> {
    const { ownerId, studyId, jobId } = scope;
    const study = await this.access.requireOwnedStudy(ownerId, studyId, { transaction });
    const manifest = await ContextManifest.findOne({
      where: { ownerId, studyId, jobId },
      attributes: ['id'],
      transaction,
    });
    if (!manifest) throw new Error('AiSummary: a summary job has no context manifest');
    const current = scope.basisRevision === study.contentRevision;
    const id = randomUUID();
    const { gathered } = input;
    await StudySummary.create(
      {
        id,
        ownerId,
        studyId,
        jobId,
        basisContentRevision: scope.basisRevision,
        publishedCurrent: current,
        summaryJson: buildStudySummary({
          id,
          valid: input.valid,
          studyId,
          title: gathered.title,
          basisContentRevision: scope.basisRevision,
          generatedAt: new Date(),
          promptVersion: scope.promptVersion,
          modelId: scope.modelId,
          contextManifestId: manifest.id,
          coverageWarnings: input.coverageWarnings,
          nodes: gathered.nodes,
          originalQuestionId: gathered.originalQuestionNodeId,
          currentQuestionId: gathered.mainQuestionNodeId,
        }),
        modelId: scope.modelId,
        promptVersion: scope.promptVersion,
        schemaVersion: SUMMARY_SCHEMA_VERSION,
      },
      { transaction },
    );
    // The study now has a summary: the debounce watches it from here on.
    const schedule = await StudySummarySchedule.findOne({
      where: { ownerId, studyId },
      lock: true,
      transaction,
    });
    if (!schedule) {
      // Observed as of the basis, not the study's current revision: a change committed while this
      // first summary ran is then seen by the next debounce pass and gets its follow-up.
      await StudySummarySchedule.create(
        {
          ownerId,
          studyId,
          observedRevision: scope.basisRevision,
          summarizedRevision: scope.basisRevision,
          firstDirtyAt: null,
          lastDirtyAt: null,
        },
        { transaction },
      );
    } else if (scope.basisRevision > schedule.summarizedRevision) {
      const caughtUp = scope.basisRevision >= schedule.observedRevision;
      await schedule.update(
        {
          summarizedRevision: scope.basisRevision,
          ...(caughtUp ? { firstDirtyAt: null, lastDirtyAt: null } : {}),
          updatedAt: new Date(),
        },
        { transaction },
      );
    }
    return { summaryId: id, current, droppedCount: input.valid.dropped };
  }

  /** `GET /studies/:id/summary`. Owner-scoped: another user's study is the same 404. */
  async get(ownerId: string, studyId: string): Promise<StudySummaryResponse> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const scope = { ownerId, studyId: study.id };
    const order: [string, string][] = [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ];
    const row =
      (await StudySummary.findOne({ where: { ...scope, publishedCurrent: true }, order })) ??
      (await StudySummary.findOne({ where: scope, order }));
    const generating =
      (await AiJob.count({
        where: { ...scope, capability: 'summary', state: ['queued', 'running'] },
      })) > 0;
    const failed = await AiJob.findOne({
      where: {
        ...scope,
        capability: 'summary',
        state: ['failed', 'cancelled'],
        ...(row ? { finishedAt: { [Op.gt]: row.createdAt } } : {}),
      },
      order: [['finishedAt', 'DESC']],
    });
    return {
      summary: row?.summaryJson ?? null,
      stale: row !== null && row.basisContentRevision < study.contentRevision,
      currentContentRevision: study.contentRevision,
      generating,
      lastFailure:
        failed?.errorCode != null
          ? {
              errorCode: failed.errorCode,
              retryable: RETRYABLE_AI_JOB_ERRORS.has(failed.errorCode),
            }
          : null,
    };
  }

  /**
   * One debounce pass over the studies that have a summary (the worker calls it every poll).
   * Returns how many automatic summary jobs it queued. Ids and counts only are logged. `only`
   * limits the pass to one study (tests drive one study's clock this way).
   */
  async scheduleAutomatic(
    now = new Date(),
    only?: { ownerId: string; studyId: string },
  ): Promise<number> {
    const schedules = await StudySummarySchedule.findAll(only ? { where: only } : {});
    if (schedules.length === 0) return 0;
    const revisions = await this.access.contentRevisions(schedules);
    const debounce = this.runtime.summaryDebounceMs ?? SUMMARY_DEBOUNCE_MS;
    const maxWait = this.runtime.summaryMaxWaitMs ?? SUMMARY_MAX_WAIT_MS;
    let queued = 0;
    for (const schedule of schedules) {
      const study = revisions.get(schedule.studyId);
      if (!study || study.lifecycle === 'trashed') continue;
      if (study.contentRevision > schedule.observedRevision) {
        // A significant change committed since the last pass: the summary is stale from now on.
        await schedule.update({
          observedRevision: study.contentRevision,
          firstDirtyAt: schedule.firstDirtyAt ?? now,
          lastDirtyAt: now,
          updatedAt: now,
        });
      }
      const { firstDirtyAt, lastDirtyAt } = schedule;
      if (!firstDirtyAt || !lastDirtyAt) continue;
      if (study.contentRevision <= schedule.summarizedRevision) {
        await schedule.update({ firstDirtyAt: null, lastDirtyAt: null, updatedAt: now });
        continue;
      }
      const due =
        now.getTime() - lastDirtyAt.getTime() >= debounce ||
        now.getTime() - firstDirtyAt.getTime() >= maxWait;
      if (!due) continue;
      const running = await AiJob.count({
        where: {
          ownerId: schedule.ownerId,
          studyId: schedule.studyId,
          capability: 'summary',
          state: ['queued', 'running'],
        },
      });
      // One summary job per study: the change stays dirty and gets one follow-up afterwards.
      if (running > 0) continue;
      const enqueued = await this.jobs.requestAutomaticSummary(
        schedule.ownerId,
        schedule.studyId,
        study.contentRevision,
      );
      if (enqueued) queued += 1;
      // Queued or not allowed now (AI off, limits): either way this change is handled; the next
      // significant change starts a new debounce.
      await schedule.update({
        summarizedRevision: study.contentRevision,
        firstDirtyAt: null,
        lastDirtyAt: null,
        updatedAt: now,
      });
    }
    if (queued > 0) this.logger.log('ai_summary_auto_queued', { count: queued });
    return queued;
  }
}
