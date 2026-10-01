import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';

/**
 * Boots the real AppModule (or a test module that imports it) against the test database, with
 * the same HTTP setup as the running server.
 */
export async function createTestApp(
  rootModule: Type<unknown> = AppModule,
): Promise<INestApplication<Server>> {
  const moduleRef = await Test.createTestingModule({ imports: [rootModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
  configureApp(app, app.get<Env>(ENV));
  await app.init();
  return app;
}
