import { describe, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from './openapi';

describe('buildOpenApiDocument', () => {
  it('documents every path with its success response and the ErrorEnvelope as default', () => {
    const errorResponse = {
      description: 'Error (shared error envelope, PRD section 24)',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
    const doc = buildOpenApiDocument();
    expect({ openapi: doc.openapi, servers: doc.servers, paths: doc.paths }).toStrictEqual({
      openapi: '3.0.0',
      servers: [{ url: '/v1' }],
      paths: {
        '/health': {
          get: {
            description: 'Reports API and database liveness.',
            responses: {
              200: {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
                },
              },
              default: errorResponse,
            },
          },
        },
        '/openapi.json': {
          get: {
            description: 'Returns this OpenAPI document.',
            responses: {
              200: {
                description: 'OpenAPI 3.0 document for /v1',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              default: errorResponse,
            },
          },
        },
      },
    });
  });

  it('builds the document once and returns the same frozen object', () => {
    const doc = buildOpenApiDocument();
    expect(buildOpenApiDocument()).toBe(doc);
    expect(Object.isFrozen(doc.components.schemas)).toBe(true);
  });

  it('generates the error envelope and health schemas', () => {
    const doc = buildOpenApiDocument();
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
