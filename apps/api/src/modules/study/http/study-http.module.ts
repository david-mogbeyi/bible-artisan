import { Module } from '@nestjs/common';
import { MutationModule } from '../../../common/mutation/mutation.module';
import { BibleContentModule } from '../../bible-content/bible-content.module';
import { NotesModule } from '../../notes/notes.module';
import { StudyModule } from '../study.module';
import { StudiesController } from './studies.controller';
import { StudiesService } from './studies.service';

/**
 * The Study context's HTTP routes (BIB-19). Separate from `StudyModule` because they run
 * mutations: `MutationModule` imports `StudyModule`, so `StudyModule` cannot import it back.
 * Library search over note text goes through Notes' exported `NotesSearchService` (BIB-23).
 * No cycle: `NotesModule` imports `StudyModule` (services only), never this module.
 */
@Module({
  imports: [MutationModule, StudyModule, BibleContentModule, NotesModule],
  controllers: [StudiesController],
  providers: [StudiesService],
})
export class StudyHttpModule {}
