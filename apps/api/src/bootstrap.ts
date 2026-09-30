import type { INestApplication } from '@nestjs/common';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import type { Env } from './config/env';

/** Shared HTTP setup so the running server and integration tests behave identically. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.setGlobalPrefix('v1');
  app.enableCors({ origin: env.CORS_ALLOWED_ORIGINS, credentials: true });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
