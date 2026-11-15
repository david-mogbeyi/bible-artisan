import { Module } from '@nestjs/common';
import { MutationModule } from '../../../common/mutation/mutation.module';
import { BibleContentModule } from '../../bible-content/bible-content.module';
import { StudyModule } from '../../study/study.module';
import { ActivityService } from './activity.service';
import { ThreadController } from './thread.controller';
import { ThreadEventsService } from './thread-events.service';

/**
 * The Thread context's HTTP routes (BIB-55, BIB-32). Separate from `ThreadModule` because the
 * activity route runs mutations: `MutationModule` imports `ThreadModule`, so `ThreadModule`
 * cannot import it back. Reads `study_event` (Thread's own table); node labels come through
 * Study's `StudyAccessService`, branch roots through `StudyGraphService`, and passage labels
 * through Bible Content's `ReferenceService`.
 */
@Module({
  imports: [MutationModule, StudyModule, BibleContentModule],
  controllers: [ThreadController],
  providers: [ActivityService, ThreadEventsService],
})
export class ThreadHttpModule {}
