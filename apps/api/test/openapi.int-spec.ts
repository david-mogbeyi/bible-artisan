import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from './app';

describe('GET /v1/openapi.json', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a document generated from the current contracts schemas', async () => {
    const res = await request(app.getHttpServer()).get('/v1/openapi.json').expect(200);
    const body = res.body as { openapi: string; components: { schemas: Record<string, unknown> } };
    expect(body.openapi).toBe('3.0.0');
    expect(body.components.schemas).toHaveProperty('HealthResponse');
    expect(body.components.schemas).toHaveProperty('ErrorEnvelope');
  });
});
