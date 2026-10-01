import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env';
import { runEntrypoint } from './modules/observability/entrypoint';
import { createAppLogger } from './modules/observability/logger';
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
  // BIB-22: hard-deletes studies past their 30-day trash window, now and hourly. The leased job
  // runner arrives with BIB-39; this purge is an idempotent batch that needs no lease.
  const stopPurge = scheduleTrashPurge(app.get(StudyTrashPurgeService));
  process.once('SIGTERM', stopPurge);
  process.once('SIGINT', stopPurge);
  Logger.log('Worker started', 'Worker');
  // Keep the process alive until SIGTERM/SIGINT; shutdown hooks close the DB pool.
  setInterval(() => undefined, 1 << 30);
}

void runEntrypoint('worker', bootstrap);
