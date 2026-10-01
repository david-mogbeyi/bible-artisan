import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requireJsonBody } from './common/http/require-json-body';
import { requireTrustedOrigin } from './common/http/require-trusted-origin';
import type { Env } from './config/env';

/** Shared HTTP setup so the running server and integration tests behave identically. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.setGlobalPrefix('v1');
  // CSRF (PRD §29). Both must be registered before init(), so they run ahead of the json/urlencoded
  // body parsers Nest adds there, the session guard, and every handler, public ones included.
  // 1. A mutation from a browser origin outside the CORS allowlist is refused with 403.
  app.use(requireTrustedOrigin(env.CORS_ALLOWED_ORIGINS));
  // 2. A non-JSON mutation is refused with 415 before any parser reads it (login CSRF).
  app.use(requireJsonBody);
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
