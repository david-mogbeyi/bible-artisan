import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env';
import { AiJobRunnerService } from './modules/ai/ai-job-runner.service';
import { ExportPurgeService } from './modules/exports/export-purge.service';
import { AccountPurgeService } from './modules/identity/account-purge.service';
import { schedulePrivacyPurge } from './modules/identity/privacy-purge-schedule';
import { runEntrypoint } from './modules/observability/entrypoint';
import { createAppLogger } from './modules/observability/logger';
import { OperationalAlertsService } from './modules/observability/operational-alerts.service';
import { StudyTrashPurgeService } from './modules/study/trash/study-trash-purge.service';
import { scheduleTrashPurge } from './modules/study/trash/trash-purge-schedule';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: createAppLogger(loadEnv()),
    // Startup errors propagate to runEntrypoint instead of Nest logging and exiting itself.
    abortOnError: false,
  });
  app.enableShutdownHooks();
  // BIB-22: hard-deletes studies past their 30-day trash window, now and hourly. This purge is an
  // idempotent batch that needs no lease.
  const stopPurge = scheduleTrashPurge(app.get(StudyTrashPurgeService));
  // BIB-39: leased AI jobs. A job interrupted by shutdown is reclaimed when its lease expires.
  const stopAiJobs = app.get(AiJobRunnerService).start();
  // BIB-47 / BIB-48: purges deleted accounts (and reapplies deletion tombstones) and expired
  // export files, now and hourly.
  const stopPrivacyPurge = schedulePrivacyPurge({
    accounts: app.get(AccountPurgeService),
    exports: app.get(ExportPurgeService),
  });
  // BIB-50: evaluates the section 30 alert rules every minute and logs `ops_metrics` / `ops_alert`.
  const stopAlerts = app.get(OperationalAlertsService).start();
  const stop = (): void => {
    stopPurge();
    stopAiJobs();
    stopPrivacyPurge();
    stopAlerts();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  Logger.log('Worker started', 'Worker');
  // Keep the process alive until SIGTERM/SIGINT; shutdown hooks close the DB pool.
  setInterval(() => undefined, 1 << 30);
}

void runEntrypoint('worker', bootstrap);
