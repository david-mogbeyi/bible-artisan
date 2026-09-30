import { z } from 'zod';
import { errorEnvelopeSchema } from './error-envelope';
import { healthResponseSchema } from './health';

/** JSON-schema object as emitted by `z.toJSONSchema` (OpenAPI 3.0 target). */
type SchemaObject = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: '3.0.0';
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, SchemaObject> };
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

function buildDocument(): OpenApiDocument {
  return {
    openapi: '3.0.0',
    info: { title: 'Bible Artisan API', version: '0.0.0' },
    servers: [{ url: '/v1' }],
    paths: {
      '/health': {
        get: {
          description: 'Reports API and database liveness.',
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: ref('HealthResponse') } },
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
    components: {
      schemas: {
        HealthResponse: toSchema(healthResponseSchema),
        ErrorEnvelope: toSchema(errorEnvelopeSchema),
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
