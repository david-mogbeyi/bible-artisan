import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ENV } from './config/config.module';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(ENV);
  configureApp(app, env);
  await app.listen(env.API_PORT);
  Logger.log(`API listening on http://localhost:${env.API_PORT}/v1`, 'Bootstrap');
}

void bootstrap();
