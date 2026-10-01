import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env';
import { runEntrypoint } from './modules/observability/entrypoint';
import { createAppLogger } from './modules/observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: createAppLogger(loadEnv()),
    // Startup errors propagate to runEntrypoint instead of Nest logging and exiting itself.
    abortOnError: false,
  });
  app.enableShutdownHooks();
  Logger.log('Worker started (no job runners registered yet)', 'Worker');
  // Keep the process alive until SIGTERM/SIGINT; shutdown hooks close the DB pool.
  setInterval(() => undefined, 1 << 30);
}

void runEntrypoint('worker', bootstrap);
