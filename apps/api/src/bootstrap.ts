import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { Env } from './config/env';

/** Shared HTTP setup so the running server and integration tests behave identically. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.setGlobalPrefix('v1');
  // Retry-After is exposed so the web client can show a resend countdown after a 429.
  app.enableCors({
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
    exposedHeaders: ['Retry-After'],
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
