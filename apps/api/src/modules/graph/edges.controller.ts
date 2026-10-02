import { Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import type { EdgeListResponse } from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { EdgesService } from './edges.service';

/**
 * `/v1/studies/:studyId/edges` (BIB-27): typed relationships between nodes. The owner is always
 * the session's; another user's, absent and malformed study, edge and node ids, and an edge or
 * node of another study, are the same 404. Mutations need `expectedRevision` (428 / 409) and take
 * an `Idempotency-Key`; they return the `MutationResult` itself, which the global interceptor
 * sends after COMMIT.
 */
@Controller('studies/:studyId/edges')
export class EdgesController {
  constructor(private readonly edges: EdgesService) {}

  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.edges.create(ownerId, studyId, mutation);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<EdgeListResponse> {
    return this.edges.list(ownerId, studyId, query);
  }

  @Patch(':edgeId')
  update(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('edgeId', ParseResourceIdPipe) edgeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.edges.update(ownerId, studyId, edgeId, mutation);
  }

  @Delete(':edgeId')
  remove(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('edgeId', ParseResourceIdPipe) edgeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.edges.remove(ownerId, studyId, edgeId, mutation);
  }
}
