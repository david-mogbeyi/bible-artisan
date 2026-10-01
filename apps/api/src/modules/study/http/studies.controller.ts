import { Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import type { StudyListResponse, StudyResponse } from '@bible-artisan/contracts';
import {
  MutationRequest,
  type MutationRequestInfo,
} from '../../../common/mutation/mutation-request';
import { MutationResult } from '../../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../../common/validation/resource-id';
import { CurrentUserId } from '../../identity/current-user.decorator';
import { StudiesService } from './studies.service';

/**
 * `/v1/studies` (BIB-19). The owner is always the session's (`@CurrentUserId()`); the request
 * body can never name one (the contract is strict).
 */
@Controller('studies')
export class StudiesController {
  constructor(private readonly studies: StudiesService) {}

  /**
   * Creates a study. No `expectedRevision` (nothing exists yet, so never 428); an
   * `Idempotency-Key` makes a retry replay the original 201 instead of creating another study.
   * Returns the `MutationResult` itself: the global interceptor sends it after COMMIT.
   */
  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.create(ownerId, mutation);
  }

  /**
   * Edits the study's title, description, main question, pin or tags (BIB-20). Needs
   * `expectedRevision` (428 / 409); an `Idempotency-Key` makes a retry replay the original 200.
   * Returns the `MutationResult` itself: the global interceptor sends it after COMMIT.
   */
  @Patch(':studyId')
  update(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.update(ownerId, studyId, mutation);
  }

  /**
   * Moves the study to the trash (BIB-22). Recoverable with `POST :studyId/restore` for 30 days;
   * nothing is deleted now. Same contract as the other lifecycle routes below.
   */
  @Delete(':studyId')
  trash(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.changeLifecycle(ownerId, studyId, mutation, 'trash');
  }

  /**
   * Archives an active study (BIB-22): read-only, out of the active library. Body
   * `{ expectedRevision }` (428 / 409); an `Idempotency-Key` makes a retry replay the original
   * 200. A starting state the change does not allow is 422.
   */
  @Post(':studyId/archive')
  archive(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.changeLifecycle(ownerId, studyId, mutation, 'archive');
  }

  /** Makes an archived study active again (BIB-22). Same contract as archive. */
  @Post(':studyId/unarchive')
  unarchive(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.changeLifecycle(ownerId, studyId, mutation, 'unarchive');
  }

  /**
   * Restores a trashed study inside its recovery window to the state it was trashed from
   * (BIB-22). Same contract as archive.
   */
  @Post(':studyId/restore')
  restore(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.studies.changeLifecycle(ownerId, studyId, mutation, 'restore');
  }

  /**
   * The owner's library (BIB-21): their own studies only, pinned first, searchable, filterable by
   * one of their tags, in keyset pages. Read-only.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUserId() ownerId: string, @Query() query: unknown): Promise<StudyListResponse> {
    return this.studies.list(ownerId, query);
  }

  /** One of the owner's studies; another user's, absent and malformed ids are the same 404. */
  @Get(':studyId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<StudyResponse> {
    return this.studies.get(ownerId, studyId);
  }
}
