import { Controller, Get, Header, Param, Patch, Post } from '@nestjs/common';
import type { NodeListResponse, NodeResponse } from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { NodesService } from './nodes.service';

/**
 * `/v1/studies/:studyId/nodes` (BIB-25). The owner is always the session's; another user's,
 * absent and malformed study and node ids, and a node of another study, are the same 404.
 * Mutations need `expectedRevision` (428 / 409) and take an `Idempotency-Key`; they return the
 * `MutationResult` itself, which the global interceptor sends after COMMIT.
 */
@Controller('studies/:studyId/nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.nodes.create(ownerId, studyId, mutation);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<NodeListResponse> {
    return this.nodes.list(ownerId, studyId);
  }

  @Get(':nodeId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
  ): Promise<NodeResponse> {
    return this.nodes.get(ownerId, studyId, nodeId);
  }

  @Patch(':nodeId')
  update(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.nodes.update(ownerId, studyId, nodeId, mutation);
  }
}
