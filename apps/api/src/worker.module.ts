import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AiModule } from './modules/ai/ai.module';
import { ExportPurgeModule } from './modules/exports/export-purge.module';
import { AccountPurgeModule } from './modules/identity/account-purge.module';
import { OperationalAlertsModule } from './modules/observability/operational-alerts.module';
import { StudyTrashModule } from './modules/study/trash/study-trash.module';

/**
 * Background worker: PostgreSQL-leased jobs. AI jobs (BIB-39) run through `AiJobRunnerService`
 * (`SELECT … FOR UPDATE SKIP LOCKED` leases); the study trash purge (BIB-22) and the privacy
 * purges (BIB-47, BIB-48: deleted accounts, expired export files) run on plain schedules, and so
 * does the operational alert evaluator (BIB-50).
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    StudyTrashModule,
    AiModule,
    AccountPurgeModule,
    ExportPurgeModule,
    OperationalAlertsModule,
  ],
})
export class WorkerModule {}
