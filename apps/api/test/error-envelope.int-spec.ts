import type { Server } from 'node:http';
import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { errorEnvelopeSchema } from '@bible-artisan/contracts';
import { ConnectionRefusedError } from 'sequelize';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Public } from '../src/modules/identity/public.decorator';
import { configureApp } from '../src/bootstrap';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../src/common/errors/domain-errors';

/**
 * Test-only controller that throws each mapped domain exception, colocated with the test per the
 * ticket's Testing requirements (no real mutation route exists yet to exercise this through).
 * Exercises the real global filter registered by `configureApp`, not a hand-called function.
 */
@Public()
@Controller('__test-errors')
class TestErrorsController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('Study not found');
  }

  @Get('validation')
  validation(): never {
    throw new ValidationError('Title is required', { title: ['is required'] });
  }

  @Get('revision-missing')
  revisionMissing(): never {
    throw new RevisionMissingError();
  }

  @Get('revision-conflict')
  revisionConflict(): never {
    throw new RevisionConflictError(7);
  }

  @Get('db-down')
  dbDown(): never {
    throw new ConnectionRefusedError(new Error('connect ECONNREFUSED'));
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Get('unexpected')
  unexpected(): never {
    throw new TypeError('private note body must never leak');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Module({ controllers: [TestErrorsController] })
class TestErrorsModule {}

describe('global exception filter → error envelope', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TestErrorsModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    configureApp(app, app.get<Env>(ENV));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps NotFoundError to 404', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/not-found').expect(404);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'NOT_FOUND',
      message: 'Study not found',
      retryable: false,
      correlationId: expect.any(String),
    });
  });

  it('maps ValidationError to 400 with fieldErrors', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/validation').expect(400);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'VALIDATION',
      message: 'Title is required',
      fieldErrors: { title: ['is required'] },
      retryable: false,
      correlationId: expect.any(String),
    });
  });

  it('maps RevisionMissingError to 428', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/revision-missing')
      .expect(428);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'REVISION_MISSING',
      message: 'expectedRevision is required',
      retryable: false,
      correlationId: expect.any(String),
    });
  });

  it('maps RevisionConflictError to 409 with currentRevision', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/revision-conflict')
      .expect(409);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'REVISION_CONFLICT',
      message: 'Revision conflict',
      retryable: false,
      correlationId: expect.any(String),
      currentRevision: 7,
    });
  });

  it('maps a database connection failure to 503, retryable', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/db-down').expect(503);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'A required service is temporarily unavailable',
      retryable: true,
      correlationId: expect.stringMatching(UUID),
    });
  });

  it('maps an unexpected error to 500, not retryable, without leaking its message', async () => {
    const res = await request(app.getHttpServer()).get('/v1/__test-errors/unexpected').expect(500);
    expect(errorEnvelopeSchema.parse(res.body)).toStrictEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      retryable: false,
      correlationId: expect.stringMatching(UUID),
    });
  });

  it('maps an over-limit JSON body (body-parser 413) to the envelope without echoing it', async () => {
    const oversized = JSON.stringify({ note: 'x'.repeat(200 * 1024) });
    const res = await request(app.getHttpServer())
      .post('/v1/__test-errors/echo')
      .set('content-type', 'application/json')
      .send(oversized)
      .expect(413);
    expect(res.body).toStrictEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Payload Too Large',
      retryable: false,
      correlationId: expect.stringMatching(UUID),
    });
  });

  it('maps a malformed JSON body (body-parser 400) to the envelope without echoing it', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/__test-errors/echo')
      .set('content-type', 'application/json')
      .send('{"note": "Romans 8:28 private')
      .expect(400);
    expect(res.body).toStrictEqual({
      code: 'BAD_REQUEST',
      message: 'Bad Request',
      retryable: false,
      correlationId: expect.stringMatching(UUID),
    });
  });

  it('maps an unknown route (Nest 404) to the envelope without echoing the path', async () => {
    const res = await request(app.getHttpServer()).get('/v1/no-such-route/romans-8-28').expect(404);
    expect(res.body).toStrictEqual({
      code: 'NOT_FOUND',
      message: 'Not Found',
      retryable: false,
      correlationId: expect.stringMatching(UUID),
    });
  });

  it('echoes a supplied UUID correlation ID', async () => {
    const correlationId = '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42';
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/not-found')
      .set('x-correlation-id', correlationId)
      .expect(404);
    expect(errorEnvelopeSchema.parse(res.body).correlationId).toBe(correlationId);
  });

  it.each([
    ['empty', ''],
    ['free text', 'fixed-correlation-id'],
    ['oversized', 'a'.repeat(4096)],
  ])('replaces a %s correlation ID header with a fresh UUID', async (_label, header) => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/not-found')
      .set('x-correlation-id', header)
      .expect(404);
    const { correlationId } = errorEnvelopeSchema.parse(res.body);
    expect(correlationId).toMatch(UUID);
    expect(correlationId).not.toBe(header);
  });
});
