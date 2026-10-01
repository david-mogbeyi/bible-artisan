import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';
import { runEntrypoint } from './modules/observability/entrypoint';
import { createAppLogger } from './modules/observability/logger';

async function bootstrap(): Promise<void> {
  // Loaded before the app so startup logs already use the content-redacted logger (JSON in
  // production). Invalid config throws here; runEntrypoint logs one content-free JSON line and
  // exits non-zero, so no probe ever answers.
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: createAppLogger(env),
    // Startup errors propagate to runEntrypoint instead of Nest logging and exiting itself.
    abortOnError: false,
  });
  configureApp(app, env);
  await app.listen(env.API_PORT);
  Logger.log(`API listening on port ${env.API_PORT}`, 'Bootstrap');
}

void runEntrypoint('api', bootstrap);
