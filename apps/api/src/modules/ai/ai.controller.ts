import { Controller, Get, Header, HttpCode, Param, Post, Put } from '@nestjs/common';
import type {
  AiConsentResponse,
  AiJobAcceptedResponse,
  AiJobResponse,
  StudyAiSettingsResponse,
} from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { AiJobsService } from './ai-jobs.service';
import { AiSettingsService } from './ai-settings.service';

/**
 * `/v1/me/ai-consent` (BIB-40): the account's AI consent. The owner is the session's; the PUT
 * needs the settings revision as `expectedRevision` and takes an `Idempotency-Key`.
 */
@Controller('me/ai-consent')
export class AiConsentController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentUserId() ownerId: string): Promise<AiConsentResponse> {
    return this.settings.consent(ownerId);
  }

  @Put()
  update(
    @CurrentUserId() ownerId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.settings.updateConsent(ownerId, mutation);
  }
}

/**
 * `/v1/studies/:studyId/ai/...` (BIB-39/40): the study's AI switch, AI requests (202, the work
 * happens in the worker) and job status. Another user's, an absent and a malformed study or job
 * id are the same 404.
 */
@Controller('studies/:studyId/ai')
export class StudyAiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly jobs: AiJobsService,
  ) {}

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  getSettings(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<StudyAiSettingsResponse> {
    return this.settings.studySettings(ownerId, studyId);
  }

  @Put('settings')
  updateSettings(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.settings.updateStudySettings(ownerId, studyId, mutation);
  }

  @Post('summary')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  requestSummary(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    return this.jobs.request(ownerId, studyId, 'summary', mutation.idempotencyKey);
  }

  @Get('jobs/:jobId')
  @Header('Cache-Control', 'no-store')
  getJob(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('jobId', ParseResourceIdPipe) jobId: string,
  ): Promise<AiJobResponse> {
    return this.jobs.get(ownerId, studyId, jobId);
  }
}
