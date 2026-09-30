import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Worker started (no job runners registered yet)', 'Worker');
  // Keep the process alive until SIGTERM/SIGINT; shutdown hooks close the DB pool.
  setInterval(() => undefined, 1 << 30);
}

void bootstrap();
