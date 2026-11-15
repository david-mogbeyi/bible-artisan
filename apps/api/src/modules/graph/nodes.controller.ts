import { Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  DeletedNodeListResponse,
  NodeListResponse,
  NodeResponse,
  NodeVersionListResponse,
} from '@bible-artisan/contracts';
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

  /** `?state=live` (default) or `deleted` (BIB-31). */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<NodeListResponse | DeletedNodeListResponse> {
    return this.nodes.list(ownerId, studyId, query);
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

  @Get(':nodeId/versions')
  @Header('Cache-Control', 'no-store')
  versions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
  ): Promise<NodeVersionListResponse> {
    return this.nodes.versions(ownerId, studyId, nodeId);
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

  /** BIB-31: soft-deletes the node and its live relationships. */
  @Delete(':nodeId')
  delete(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.nodes.delete(ownerId, studyId, nodeId, mutation);
  }

  /** BIB-31: brings a deleted node back with the relationships its deletion removed. */
  @Post(':nodeId/restore')
  restore(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.nodes.restore(ownerId, studyId, nodeId, mutation);
  }

  /** BIB-61: a new node with this one's current content and nothing else. */
  @Post(':nodeId/duplicate')
  duplicate(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.nodes.duplicate(ownerId, studyId, nodeId, mutation);
  }
}
