import type { INestApplication } from '@nestjs/common';
import { json } from 'body-parser';
import {
  CORRELATION_ID_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  MAX_NOTE_BODY_BYTES,
} from '@bible-artisan/contracts';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requireJsonBody } from './common/http/require-json-body';
import { requireTrustedOrigin } from './common/http/require-trusted-origin';
import { cursorSecret, httpAllowedOrigins, type Env } from './config/env';
import { SessionService } from './modules/identity/session.service';
import { parseBodyWhenSignedIn } from './modules/identity/signed-in-body-parser';
import { requestLogging } from './modules/observability/request-logging';

/** Shared HTTP setup so the running server and integration tests behave identically. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  // Throws in production when CORS_ALLOWED_ORIGINS is unset, so the API never listens without it.
  const allowedOrigins = httpAllowedOrigins(env);
  // Throws in production when CURSOR_SECRET is unset: library cursors are never sealed with the
  // public development secret (BIB-21).
  cursorSecret(env);
  app.setGlobalPrefix('v1');
  // Observability (BIB-13) goes FIRST: every request gets its correlation ID (and the
  // X-Correlation-Id response header) and exactly one allowlisted access log line, including
  // requests the CSRF/JSON middlewares or the body parsers refuse below.
  app.use(requestLogging);
  // CSRF (PRD §29). Both must be registered before init(), so they run ahead of the json/urlencoded
  // body parsers Nest adds there, the session guard, and every handler, public ones included.
  // 1. A mutation from a browser origin outside the CORS allowlist is refused with 403.
  app.use(requireTrustedOrigin(allowedOrigins));
  // 2. A non-JSON mutation is refused with 415 before any parser reads it (login CSRF).
  app.use(requireJsonBody);
  // Note routes (BIB-23) take rich-text documents of up to 50,000 characters, which can exceed
  // the default 100 kB JSON limit (non-ASCII text, formatting). Only their bodies are parsed here,
  // up to 1 MiB (larger is 413), and only for a signed-in client: the session cookie is resolved
  // first (`parseBodyWhenSignedIn`), and an anonymous request is left to Nest's default 100 kB
  // parser and then the SessionGuard's 401, so no one can make the API buffer 1 MiB before
  // authenticating. Nest's own parser, registered at init(), skips a body that is already parsed,
  // so every other route keeps the default limit. The wrapper's name matters: Nest does not
  // register its global parser at all when a layer named `jsonParser` (body-parser's own function
  // name) is already mounted.
  const noteJson = json({ limit: MAX_NOTE_BODY_BYTES });
  app.use(
    '/v1/studies/:studyId/notes',
    parseBodyWhenSignedIn(app.get(SessionService), (req, res, next) => {
      noteJson(req, res, next);
    }),
  );
  // Retry-After is exposed so the web client can show a resend countdown after a 429 (and back
  // off after a 503). Idempotent-Replayed lets the save queue tell a replayed mutation response
  // from a fresh one (BIB-12); without it a cross-origin fetch cannot read the header.
  // X-Correlation-Id lets the web app report the ID of a failed request (BIB-13).
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['Retry-After', IDEMPOTENT_REPLAYED_HEADER, CORRELATION_ID_HEADER],
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
