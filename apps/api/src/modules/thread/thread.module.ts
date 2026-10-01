import { Module } from '@nestjs/common';
import { StudyModule } from '../study/study.module';
import { ThreadService } from './thread.service';

/**
 * Thread bounded context (PRD §26). Owns `study_event`. Exports `ThreadService`, which Graph,
 * Notes, and Study call inside their own mutation transactions to append the matching event
 * (sequence allocated through Study's `StudyRevisionService`).
 */
@Module({
  imports: [StudyModule],
  providers: [ThreadService],
  exports: [ThreadService],
})
export class ThreadModule {}
