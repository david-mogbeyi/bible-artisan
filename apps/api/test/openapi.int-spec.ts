import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildOpenApiDocument } from '@bible-artisan/contracts/openapi';
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
    // The whole served document, including each path's `default` ErrorEnvelope response.
    expect(res.body).toStrictEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});
