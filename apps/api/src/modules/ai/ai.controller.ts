import { Controller, Get, Header, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  type AiConsentResponse,
  type AiJobAcceptedResponse,
  type AiJobResponse,
  type AiProposalListResponse,
  type AiSuggestionListResponse,
  requestAiInsightSchema,
  requestRelationshipsSchema,
  type StudyAiSettingsResponse,
  type StudySummaryResponse,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
import { StudyAccessService } from '../study/study-access.service';
import { AiSuggestionsService } from './ai-suggestions.service';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { AiJobsService } from './ai-jobs.service';
import { AiSettingsService } from './ai-settings.service';
import { AiSummaryService } from './ai-summary.service';

/** `GET /v1/studies/:studyId/summary` (BIB-43): the living summary and its freshness. */
@Controller('studies/:studyId/summary')
export class StudySummaryController {
  constructor(private readonly summaries: AiSummaryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<StudySummaryResponse> {
    return this.summaries.get(ownerId, studyId);
  }
}

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
    private readonly suggestions: AiSuggestionsService,
    private readonly access: StudyAccessService,
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

  /**
   * BIB-42: relationship proposals between two live nodes of the study (202, an AI job). Either
   * node absent, deleted or another study's or user's: 404.
   */
  @Post('relationships')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async requestRelationships(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    const body = parseBody(requestRelationshipsSchema, mutation.body);
    await this.access.requireOwnedNode(ownerId, studyId, body.sourceNodeId);
    await this.access.requireOwnedNode(ownerId, studyId, body.targetNodeId);
    return this.jobs.request(ownerId, studyId, 'relationships', mutation.idempotencyKey, {
      sourceNodeId: body.sourceNodeId,
      targetNodeId: body.targetNodeId,
      regenerate: body.regenerate === true,
    });
  }

  /** BIB-44: proposed tensions between claims (202). Never changes a status. */
  @Post('tensions')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  requestTensions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    return this.requestInsight(ownerId, studyId, 'tensions', mutation);
  }

  /** BIB-44: existing open questions plus proposed new ones (202). */
  @Post('questions')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  requestQuestions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    return this.requestInsight(ownerId, studyId, 'questions', mutation);
  }

  /** BIB-45: verified next passages (202). */
  @Post('passages')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  requestPassages(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    return this.requestInsight(ownerId, studyId, 'passages', mutation);
  }

  private requestInsight(
    ownerId: string,
    studyId: string,
    capability: 'tensions' | 'questions' | 'passages',
    mutation: MutationRequestInfo,
  ): Promise<AiJobAcceptedResponse> {
    const body = parseBody(requestAiInsightSchema, mutation.body ?? {});
    return this.jobs.request(ownerId, studyId, capability, mutation.idempotencyKey, {
      regenerate: body.regenerate === true,
    });
  }

  @Get('proposals')
  @Header('Cache-Control', 'no-store')
  listProposals(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<AiProposalListResponse> {
    return this.suggestions.listProposals(ownerId, studyId, query);
  }

  @Post('proposals/:proposalId/accept')
  acceptProposal(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('proposalId', ParseResourceIdPipe) proposalId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.suggestions.acceptProposal(ownerId, studyId, proposalId, mutation);
  }

  @Post('proposals/:proposalId/reject')
  rejectProposal(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('proposalId', ParseResourceIdPipe) proposalId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.suggestions.reject(ownerId, studyId, proposalId, mutation, 'proposals');
  }

  @Get('suggestions')
  @Header('Cache-Control', 'no-store')
  listSuggestions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<AiSuggestionListResponse> {
    return this.suggestions.list(ownerId, studyId, query);
  }

  @Post('suggestions/:suggestionId/accept')
  acceptSuggestion(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('suggestionId', ParseResourceIdPipe) suggestionId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.suggestions.accept(ownerId, studyId, suggestionId, mutation);
  }

  @Post('suggestions/:suggestionId/reject')
  rejectSuggestion(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('suggestionId', ParseResourceIdPipe) suggestionId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.suggestions.reject(ownerId, studyId, suggestionId, mutation);
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
