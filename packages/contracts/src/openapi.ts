import { z } from 'zod';
import {
  meResponseSchema,
  otpStartRequestSchema,
  otpStartResponseSchema,
  otpVerifyRequestSchema,
} from './auth';
import { errorEnvelopeSchema } from './error-envelope';
import { healthResponseSchema, livenessResponseSchema } from './health';

/** JSON-schema object as emitted by `z.toJSONSchema` (OpenAPI 3.0 target). */
type SchemaObject = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: '3.0.0';
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, SchemaObject>;
    schemas: Record<string, SchemaObject>;
  };
}

/**
 * Converts one Zod schema to an OpenAPI 3.0 schema object with Zod 4's built-in converter.
 * Pure function of the schema: no prototype patching, so it works regardless of which module
 * (main barrel or this subpath) was loaded first.
 */
function toSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  return rest;
}

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

/**
 * Every error from /v1 is the shared envelope (the global exception filter guarantees it), so
 * each operation documents it as its `default` response.
 */
const errorResponse = {
  description: 'Error (shared error envelope, PRD section 24)',
  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
};

const jsonBody = (name: string): Record<string, unknown> => ({
  required: true,
  content: { 'application/json': { schema: ref(name) } },
});

const jsonResponse = (description: string, name: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});

/** Routes that require the session cookie declare it; every other route is public. */
const sessionCookie = [{ sessionCookie: [] }];

function buildDocument(): OpenApiDocument {
  return {
    openapi: '3.0.0',
    info: { title: 'Bible Artisan API', version: '0.0.0' },
    servers: [{ url: '/v1' }],
    paths: {
      '/health': {
        get: {
          description:
            'Readiness: the database answers and every shipped migration is applied. Public.',
          responses: {
            200: jsonResponse('Ready', 'HealthResponse'),
            503: jsonResponse('Not ready (database down or migrations pending)', 'HealthResponse'),
            default: errorResponse,
          },
        },
      },
      '/health/live': {
        get: {
          description: 'Liveness: the process serves HTTP. Never touches the database. Public.',
          responses: {
            200: jsonResponse('Alive', 'LivenessResponse'),
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
          requestBody: jsonBody('OtpStartRequest'),
          responses: {
            202: jsonResponse('Code sent', 'OtpStartResponse'),
            default: errorResponse,
          },
        },
      },
      '/auth/otp/verify': {
        post: {
          description:
            'Verifies a sign-in code (max 5 attempts, single use), creates or resumes the account, and sets the session cookie.',
          requestBody: jsonBody('OtpVerifyRequest'),
          responses: {
            200: jsonResponse('Signed in; Set-Cookie carries the session', 'MeResponse'),
            default: errorResponse,
          },
        },
      },
      '/auth/logout': {
        post: {
          description: 'Revokes the presented session, if any, and clears the session cookie.',
          responses: {
            204: { description: 'Signed out' },
            default: errorResponse,
          },
        },
      },
      '/me': {
        get: {
          description: 'Returns the signed-in user.',
          security: sessionCookie,
          responses: {
            200: jsonResponse('Current user', 'MeResponse'),
            default: errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ba_session' },
      },
      schemas: {
        HealthResponse: toSchema(healthResponseSchema),
        LivenessResponse: toSchema(livenessResponseSchema),
        ErrorEnvelope: toSchema(errorEnvelopeSchema),
        OtpStartRequest: toSchema(otpStartRequestSchema),
        OtpStartResponse: toSchema(otpStartResponseSchema),
        OtpVerifyRequest: toSchema(otpVerifyRequestSchema),
        MeResponse: toSchema(meResponseSchema),
      },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

let cached: OpenApiDocument | undefined;

/**
 * OpenAPI generation for /v1, built directly from the shared Zod schemas. Kept out of the main
 * barrel (`@bible-artisan/contracts`) so apps/web never bundles it; only apps/api imports this
 * subpath (`@bible-artisan/contracts/openapi`). The schemas are static, so the document is built
 * once on first use and the same deep-frozen object is returned afterwards.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  cached ??= deepFreeze(buildDocument());
  return cached;
}
