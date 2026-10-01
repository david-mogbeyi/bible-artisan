// The main barrel MUST be the first thing this file loads (regression for the old zod-to-openapi
// prototype patch, which broke when the barrel's schemas were constructed and CJS-cached first).
import { healthResponseSchema } from '@bible-artisan/contracts';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('GET /v1/openapi.json when the contracts barrel was loaded before AppModule', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    // Also load it through Node's CJS loader so the require cache holds the barrel first.
    createRequire(__filename)('@bible-artisan/contracts');
    expect(healthResponseSchema).toBeDefined();
    // Only now load the app (and, through it, the /openapi subpath).
    const { createTestApp } = await import('./app.js');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('still generates the document', async () => {
    const res = await request(app.getHttpServer()).get('/v1/openapi.json').expect(200);
    const body = res.body as { openapi: string; components: { schemas: Record<string, unknown> } };
    expect(body.openapi).toBe('3.0.0');
    expect(Object.keys(body.components.schemas)).toStrictEqual([
      'HealthResponse',
      'LivenessResponse',
      'ErrorEnvelope',
      'OtpStartRequest',
      'OtpStartResponse',
      'OtpVerifyRequest',
      'MeResponse',
      'ResolveReferenceRequest',
      'ResolveReferenceResponse',
      'SearchBibleResponse',
      'BibleTranslationsResponse',
      'BiblePassageResponse',
      'BibleReferenceRequest',
      'BibleReferenceResponse',
      'AnchorSelection',
      'CaptureAnchorResponse',
      'ResolveAnchorRequest',
      'ResolveAnchorResponse',
      'CreateStudyRequest',
      'CreateStudyResponse',
      'StudyResponse',
      'StudyListResponse',
      'UpdateStudyRequest',
      'UpdateStudyResponse',
    ]);
  });
});
