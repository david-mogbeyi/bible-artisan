import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './app';

describe('GET /v1/openapi.json', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a document generated from the current contract schemas', async () => {
    const res = await request(app.getHttpServer()).get('/v1/openapi.json').expect(200);
    const body = res.body as OpenAPIObject;
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.components?.schemas ?? {})).toStrictEqual([
      'HealthResponse',
      'ErrorEnvelope',
    ]);
  });
});
