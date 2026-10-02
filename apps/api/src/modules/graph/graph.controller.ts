import { Controller, Get, Header, Param, Patch } from '@nestjs/common';
import type { GraphResponse } from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { GraphService } from './graph.service';

/**
 * `/v1/studies/:studyId/graph` and `/positions` (BIB-28). The owner is always the session's;
 * another user's, an absent and a malformed study id, and a node of another study, are the same
 * 404. The position save needs the view revision as `expectedRevision` (428 / 409), takes an
 * `Idempotency-Key`, and returns the `MutationResult` itself, sent after COMMIT.
 */
@Controller('studies/:studyId')
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get('graph')
  @Header('Cache-Control', 'no-store')
  snapshot(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<GraphResponse> {
    return this.graph.snapshot(ownerId, studyId);
  }

  @Patch('positions')
  savePositions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.graph.savePositions(ownerId, studyId, mutation);
  }
}
