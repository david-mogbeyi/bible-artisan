import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';
import { createAppLogger } from './modules/observability/logger';

async function bootstrap(): Promise<void> {
  // Loaded before the app so startup logs already use the content-redacted logger (JSON in
  // production). Invalid config throws here and the process exits: no probe ever answers.
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: createAppLogger(env) });
  configureApp(app, env);
  await app.listen(env.API_PORT);
  Logger.log(`API listening on port ${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
