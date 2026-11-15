import { Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import type { StudyEventDetail, ThreadEventsResponse } from '@bible-artisan/contracts';
import {
  MutationRequest,
  type MutationRequestInfo,
} from '../../../common/mutation/mutation-request';
import { MutationResult } from '../../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../../common/validation/resource-id';
import { CurrentUserId } from '../../identity/current-user.decorator';
import { ActivityService } from './activity.service';
import { ThreadEventsService } from './thread-events.service';

/**
 * The Study Thread's routes (BIB-55, BIB-32): record reading activity, and read the thread. The
 * owner is always the session's; another user's, absent and malformed study and event ids are
 * the same 404.
 */
@Controller('studies/:studyId')
export class ThreadController {
  constructor(
    private readonly activity: ActivityService,
    private readonly events: ThreadEventsService,
  ) {}

  @Post('activity')
  record(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.activity.record(ownerId, studyId, mutation);
  }

  /** Explicit exit (BIB-33): ends this tab's open session in the study. */
  @Post('sessions/end')
  endSession(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.activity.endSession(ownerId, studyId, mutation);
  }

  @Get('events')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<ThreadEventsResponse> {
    return this.events.list(ownerId, studyId, query);
  }

  @Get('events/:eventId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('eventId', ParseResourceIdPipe) eventId: string,
  ): Promise<StudyEventDetail> {
    return this.events.get(ownerId, studyId, eventId);
  }
}
