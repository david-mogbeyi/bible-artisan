import { Controller, Get, Header, Param, Patch } from '@nestjs/common';
import type { ResumeResponse } from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { ResumeService } from './resume.service';

/**
 * `/v1/studies/:studyId/resume` and `/view-state` (BIB-34). The owner is always the session's;
 * another user's, an absent and a malformed study id are the same 404. The view-state save needs
 * the view revision as `expectedRevision` (428 / 409), takes an `Idempotency-Key`, and returns the
 * `MutationResult` itself, sent after COMMIT.
 */
@Controller('studies/:studyId')
export class ResumeController {
  constructor(private readonly resumes: ResumeService) {}

  @Get('resume')
  @Header('Cache-Control', 'no-store')
  resume(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<ResumeResponse> {
    return this.resumes.resume(ownerId, studyId);
  }

  @Patch('view-state')
  saveViewState(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.resumes.saveViewState(ownerId, studyId, mutation);
  }
}
