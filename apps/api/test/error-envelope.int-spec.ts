import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { ErrorEnvelope } from '@bible-artisan/contracts';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';
import { ThrowingTestModule } from './fixtures/throwing.controller';

/**
 * Proves the real Nest DomainExceptionFilter maps each domain exception to the shared error
 * envelope (PRD §24), using a test-only route (see fixtures/throwing.controller.ts) since no
 * real mutation endpoint exists yet.
 */
describe('error envelope', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ThrowingTestModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    configureApp(app, app.get<Env>(ENV));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps NotFoundError to 404 with the shared envelope', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/not-found').expect(404);
    expect(res.body).toStrictEqual({
      code: 'NOT_FOUND',
      message: 'gone',
      retryable: false,
      correlationId: expect.any(String),
    });
  });

  it('maps ValidationError to 400 with fieldErrors', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/validation').expect(400);
    expect(res.body).toStrictEqual({
      code: 'VALIDATION_ERROR',
      message: 'bad input',
      fieldErrors: { title: ['required'] },
      retryable: false,
      correlationId: expect.any(String),
    });
  });

  it('maps RevisionMissingError to 428', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/revision-missing')
      .expect(428);
    expect(res.body).toStrictEqual({
      code: 'REVISION_MISSING',
      message: 'expectedRevision is required',
      retryable: true,
      correlationId: expect.any(String),
    });
  });

  it('maps RevisionConflictError to 409 with currentRevision', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/revision-conflict')
      .expect(409);
    expect(res.body).toStrictEqual({
      code: 'REVISION_CONFLICT',
      message: 'stale',
      retryable: true,
      currentRevision: 7,
      correlationId: expect.any(String),
    });
  });

  it('gives each request a distinct correlation ID', async () => {
    const first = await request(app.getHttpServer()).get('/v1/__test-errors/not-found');
    const second = await request(app.getHttpServer()).get('/v1/__test-errors/not-found');
    const firstBody = first.body as ErrorEnvelope;
    const secondBody = second.body as ErrorEnvelope;
    expect(firstBody.correlationId).not.toBe(secondBody.correlationId);
  });
});
