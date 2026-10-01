import type { Server } from 'node:http';
import type { INestApplication, LoggerService, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';

export interface TestAppOptions {
  /** The process logger. Defaults to none, so suites stay quiet; the log-redaction suite passes one. */
  logger?: LoggerService;
  /** Provider overrides, e.g. an unreachable database for the readiness probe. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * Boots the real AppModule (or a test module that imports it) against the test database, with
 * the same HTTP setup as the running server.
 */
export async function createTestApp(
  rootModule: Type<unknown> = AppModule,
  { logger, override = (builder) => builder }: TestAppOptions = {},
): Promise<INestApplication<Server>> {
  const moduleRef = await override(Test.createTestingModule({ imports: [rootModule] })).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({
    logger: logger ?? false,
  });
  configureApp(app, app.get<Env>(ENV));
  await app.init();
  return app;
}
