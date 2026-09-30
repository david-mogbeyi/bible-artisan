import { describe, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from './openapi';

describe('buildOpenApiDocument', () => {
  it('generates a document containing the error envelope and health schemas', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.paths).toHaveProperty('/health');
    expect(doc.components.schemas).toStrictEqual({
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          database: { type: 'string', enum: ['up', 'down'] },
          version: { type: 'string' },
        },
        required: ['status', 'database', 'version'],
        additionalProperties: false,
      },
      ErrorEnvelope: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          fieldErrors: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          retryable: { type: 'boolean' },
          correlationId: { type: 'string' },
          currentRevision: {
            type: 'integer',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ['code', 'message', 'retryable', 'correlationId'],
        additionalProperties: false,
      },
    });
  });

  it('works when the main barrel is loaded before the /openapi subpath', async () => {
    // Regression: the old zod-to-openapi prototype patch broke when the barrel's schemas were
    // constructed before the patch ran. Fresh module graph, barrel first, then the subpath.
    // (The CJS require-cache variant is covered in apps/api's openapi-import-order.int-spec.ts.)
    vi.resetModules();
    const barrel = await import('./index.js');
    expect(barrel.healthResponseSchema).toBeDefined();
    const openapi = await import('./openapi.js');
    expect(Object.keys(openapi.buildOpenApiDocument().components.schemas)).toStrictEqual([
      'HealthResponse',
      'ErrorEnvelope',
    ]);
  });
});
