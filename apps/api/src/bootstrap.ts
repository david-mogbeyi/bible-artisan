import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { Env } from './config/env';

/** Shared HTTP setup so the running server and integration tests behave identically. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.setGlobalPrefix('v1');
  app.enableCors({ origin: env.CORS_ALLOWED_ORIGINS, credentials: true });
  app.enableShutdownHooks();
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
