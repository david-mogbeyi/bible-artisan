import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { StudyTrashModule } from './modules/study/trash/study-trash.module';

/**
 * Background worker: PostgreSQL-leased jobs (AI, exports, purge). Job runners arrive with BIB-39;
 * the study trash purge (BIB-22) runs on a plain schedule (`scheduleTrashPurge`).
 */
@Module({
  imports: [ConfigModule, DatabaseModule, StudyTrashModule],
})
export class WorkerModule {}
