import { Module } from '@nestjs/common';
import { MutationModule } from '../../../common/mutation/mutation.module';
import { StudyTrashPurgeService } from './study-trash-purge.service';

/**
 * The trash purge (BIB-22). Its own module because it needs `MutationService` (receipts), and
 * MutationModule imports StudyModule, so StudyModule cannot provide it. Imported by the worker.
 */
@Module({
  imports: [MutationModule],
  providers: [StudyTrashPurgeService],
  exports: [StudyTrashPurgeService],
})
export class StudyTrashModule {}
