import { Controller, Param, Patch, Post } from '@nestjs/common';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { BranchesService } from './branches.service';

/**
 * `/v1/studies/:studyId/branches` (BIB-60): start a branch and change its members. Branches are
 * read through `GET /studies/:studyId/graph`. The owner is always the session's; another user's,
 * absent and malformed study, branch and node ids, and a branch or node of another study, are the
 * same 404. Both routes need `expectedRevision` (428 / 409) and take an `Idempotency-Key`; they
 * return the `MutationResult` itself, which the global interceptor sends after COMMIT.
 */
@Controller('studies/:studyId/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.branches.create(ownerId, studyId, mutation);
  }

  @Patch(':branchId/members')
  updateMembers(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('branchId', ParseResourceIdPipe) branchId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.branches.updateMembers(ownerId, studyId, branchId, mutation);
  }
}
