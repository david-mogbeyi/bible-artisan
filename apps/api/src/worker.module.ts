import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AiModule } from './modules/ai/ai.module';
import { StudyTrashModule } from './modules/study/trash/study-trash.module';

/**
 * Background worker: PostgreSQL-leased jobs. AI jobs (BIB-39) run through `AiJobRunnerService`
 * (`SELECT … FOR UPDATE SKIP LOCKED` leases); the study trash purge (BIB-22) runs on a plain
 * schedule (`scheduleTrashPurge`).
 */
@Module({
  imports: [ConfigModule, DatabaseModule, StudyTrashModule, AiModule],
})
export class WorkerModule {}
