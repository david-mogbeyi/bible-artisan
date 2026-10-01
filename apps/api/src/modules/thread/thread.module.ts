import { Module } from '@nestjs/common';
import { ThreadService } from './thread.service';

/**
 * Thread bounded context (PRD §26). Owns `study_event`. Exports `ThreadService`, which the
 * mutation pipeline (`MutationService` → `StudyMutation.appendEvent`) calls inside a study
 * mutation's transaction, under its `StudyLock`. No controllers here: MutationModule imports this
 * module, so routes that run mutations live in a module that imports MutationModule instead.
 */
@Module({
  providers: [ThreadService],
  exports: [ThreadService],
})
export class ThreadModule {}
