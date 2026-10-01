import { Module } from '@nestjs/common';
import { MutationModule } from '../../common/mutation/mutation.module';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { StudyModule } from '../study/study.module';
import { NotesSearchService } from './notes-search.service';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

/**
 * Notes bounded context (PRD §26). Owns `note` and `note_version` (BIB-23); Annotation arrives
 * with BIB-24. Its writes run through `MutationService` (the StudyEvent commits in the same
 * transaction). Study and node reads and the study revision check go through the Study context's
 * exported services (`StudyAccessService`, `StudyRevisionService`), never its tables; Scripture
 * labels through `ReferenceService`. It exports `NotesSearchService`, through which the Study
 * library searches note text without querying `note` itself.
 */
@Module({
  imports: [MutationModule, StudyModule, BibleContentModule],
  controllers: [NotesController],
  providers: [NotesService, NotesSearchService],
  exports: [NotesSearchService],
})
export class NotesModule {}
