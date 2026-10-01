import { describe, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from './openapi';

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

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
        '/auth/otp/start': {
          post: {
            description:
              'Sends a 10-minute email sign-in code. Resend for the same email is allowed after 60 s (429 with Retry-After before that).',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('OtpStartRequest') } },
            },
            responses: {
              202: {
                description: 'Code sent',
                content: { 'application/json': { schema: ref('OtpStartResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/auth/otp/verify': {
          post: {
            description:
              'Verifies a sign-in code (max 5 attempts, single use), creates or resumes the account, and sets the session cookie.',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('OtpVerifyRequest') } },
            },
            responses: {
              200: {
                description: 'Signed in; Set-Cookie carries the session',
                content: { 'application/json': { schema: ref('MeResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/auth/logout': {
          post: {
            description: 'Revokes the presented session, if any, and clears the session cookie.',
            responses: { 204: { description: 'Signed out' }, default: errorResponse },
          },
        },
        '/me': {
          get: {
            description: 'Returns the signed-in user.',
            security: [{ sessionCookie: [] }],
            responses: {
              200: {
                description: 'Current user',
                content: { 'application/json': { schema: ref('MeResponse') } },
              },
              default: errorResponse,
            },
          },
        },
      },
    });
    expect(doc.components.securitySchemes).toStrictEqual({
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ba_session' },
    });
  });

  it('builds the document once and returns the same frozen object', () => {
    const doc = buildOpenApiDocument();
    expect(buildOpenApiDocument()).toBe(doc);
    expect(Object.isFrozen(doc.components.schemas)).toBe(true);
  });

  it('generates the error envelope and health schemas', () => {
    const { HealthResponse, ErrorEnvelope } = buildOpenApiDocument().components.schemas;
    expect({ HealthResponse, ErrorEnvelope }).toStrictEqual({
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
      'OtpStartRequest',
      'OtpStartResponse',
      'OtpVerifyRequest',
      'MeResponse',
    ]);
  });
});
