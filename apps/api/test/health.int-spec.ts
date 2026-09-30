import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@bible-artisan/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './app';

describe('GET /v1/health', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the real database as up', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(healthResponseSchema.parse(res.body)).toStrictEqual({
      status: 'ok',
      database: 'up',
      version: expect.any(String),
    });
  });
});
