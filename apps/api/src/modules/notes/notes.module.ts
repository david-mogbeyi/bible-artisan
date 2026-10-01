import { Module } from '@nestjs/common';
import { MutationModule } from '../../common/mutation/mutation.module';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { StudyModule } from '../study/study.module';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

/**
 * Notes bounded context (PRD §26). Owns `note` and `note_version` (BIB-23); Annotation arrives
 * with BIB-24. Its writes run through `MutationService` (the StudyEvent commits in the same
 * transaction); study and node lookups go through the Study context's exported services and
 * models, and Scripture labels through `ReferenceService`.
 */
@Module({
  imports: [MutationModule, StudyModule, BibleContentModule],
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
