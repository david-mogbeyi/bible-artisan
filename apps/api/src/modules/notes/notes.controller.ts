import { Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  NoteListResponse,
  NoteResponse,
  NoteVersionListResponse,
  NoteVersionResponse,
} from '@bible-artisan/contracts';
import { MutationRequest, type MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult } from '../../common/mutation/mutation.service';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { NotesService } from './notes.service';

/**
 * `/v1/studies/:studyId/notes` (BIB-23). The owner is always the session's; another user's,
 * absent and malformed study, note and version ids are the same 404. Mutations need
 * `expectedRevision` (428 / 409) and take an `Idempotency-Key`; they return the `MutationResult`
 * itself, which the global interceptor sends after COMMIT. These routes accept JSON bodies up to
 * `MAX_NOTE_BODY_BYTES` (`configureApp`); every other route keeps the default limit.
 */
@Controller('studies/:studyId/notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post()
  create(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.notes.create(ownerId, studyId, mutation);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Query() query: unknown,
  ): Promise<NoteListResponse> {
    return this.notes.list(ownerId, studyId, query);
  }

  @Get(':noteId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
  ): Promise<NoteResponse> {
    return this.notes.get(ownerId, studyId, noteId);
  }

  @Patch(':noteId')
  update(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.notes.update(ownerId, studyId, noteId, mutation);
  }

  /** Moves the note to the note trash; `POST :noteId/restore` brings it back. */
  @Delete(':noteId')
  trash(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.notes.changeState(ownerId, studyId, noteId, mutation, 'trash');
  }

  @Post(':noteId/restore')
  restore(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    return this.notes.changeState(ownerId, studyId, noteId, mutation, 'restore');
  }

  @Get(':noteId/versions')
  @Header('Cache-Control', 'no-store')
  versions(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
  ): Promise<NoteVersionListResponse> {
    return this.notes.versions(ownerId, studyId, noteId);
  }

  @Get(':noteId/versions/:versionId')
  @Header('Cache-Control', 'no-store')
  version(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('noteId', ParseResourceIdPipe) noteId: string,
    @Param('versionId', ParseResourceIdPipe) versionId: string,
  ): Promise<NoteVersionResponse> {
    return this.notes.version(ownerId, studyId, noteId, versionId);
  }
}
