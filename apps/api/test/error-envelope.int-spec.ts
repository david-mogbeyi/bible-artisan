import type { Server } from 'node:http';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { errorEnvelopeSchema } from '@bible-artisan/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
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
}

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
      retryable: true,
      correlationId: expect.any(String),
      currentRevision: 7,
    });
  });

  it('echoes a supplied correlation ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/__test-errors/not-found')
      .set('x-correlation-id', 'fixed-correlation-id')
      .expect(404);
    expect(errorEnvelopeSchema.parse(res.body).correlationId).toBe('fixed-correlation-id');
  });
});
