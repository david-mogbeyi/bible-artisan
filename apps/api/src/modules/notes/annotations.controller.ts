import { Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import type { AnnotationListResponse } from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { AnnotationsService } from './annotations.service';

/**
 * `/v1/studies/:studyId/annotations` (BIB-24): highlights. The owner is always the session's;
 * another user's, absent and malformed study and highlight ids are the same 404. Mutations need
 * `expectedRevision` (428 / 409) and take an `Idempotency-Key`; they return the `MutationResult`
 * itself, which the global interceptor sends after COMMIT. Bodies use the default JSON limit:
 * the longest real anchor fits it (BIB-18), and anything larger is 413.
 */
@Controller('studies/:studyId/annotations')
export class AnnotationsController {
  constructor(private readonly annotations: AnnotationsService) {}

  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.annotations.create(ownerId, studyId, mutation);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<AnnotationListResponse> {
    return this.annotations.list(ownerId, studyId, query);
  }

  @Patch(':annotationId')
  update(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('annotationId', ParseResourceIdPipe) annotationId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.annotations.update(ownerId, studyId, annotationId, mutation);
  }

  @Delete(':annotationId')
  remove(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('annotationId', ParseResourceIdPipe) annotationId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.annotations.remove(ownerId, studyId, annotationId, mutation);
  }
}
