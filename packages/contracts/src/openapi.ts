// Must be the first import: patches `.openapi(...)` onto Zod schemas before `./error-envelope`
// or `./health` construct any (see openapi-zod-extension.ts for why import order matters here).
// Side effect is confined to this subpath module, which only apps/api imports — the main barrel
// (`src/index.ts`) never loads this file, so apps/web's Zod usage is unaffected.
import './openapi-zod-extension';
import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorEnvelopeSchema } from './error-envelope';
import { healthResponseSchema } from './health';

/**
 * OpenAPI generation for /v1. Deliberately kept out of the main barrel (`src/index.ts` /
 * `@bible-artisan/contracts`): apps/web imports the main barrel, and this module's dependency
 * (`@asteasolutions/zod-to-openapi`) is API-only tooling that must never reach the web bundle.
 * Only apps/api imports this subpath (`@bible-artisan/contracts/openapi`).
 */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const registry = new OpenAPIRegistry();

  const health = registry.register('HealthResponse', healthResponseSchema);
  const errorEnvelope = registry.register('ErrorEnvelope', errorEnvelopeSchema);

  registry.registerPath({
    method: 'get',
    path: '/health',
    description: 'Reports API and database liveness.',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: health } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/openapi.json',
    description: 'Returns this OpenAPI document.',
    responses: {
      200: { description: 'OK' },
    },
  });

  // Registered so every mapped domain exception's response shape is documented, even though no
  // route in this ticket returns it yet (the global exception filter does, for any future route).
  void errorEnvelope;

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: { title: 'Bible Artisan API', version: '0.0.0' },
    servers: [{ url: '/v1' }],
  });
}
