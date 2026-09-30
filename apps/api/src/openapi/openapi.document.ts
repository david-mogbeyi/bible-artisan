// Imported from the /openapi subpath, not the package root: that subpath applies the
// .openapi() zod extension before these schemas are constructed. Importing schemas from the
// plain root elsewhere (e.g. apps/web, or this package's own type-only imports) stays free of
// the zod-to-openapi dependency, so it never reaches the web bundle.
import { errorEnvelopeSchema, healthResponseSchema } from '@bible-artisan/contracts/openapi';
import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

/**
 * Generates the /v1 OpenAPI document from the current @bible-artisan/contracts Zod schemas.
 * Only component schemas are registered here — no hand-written paths, since the only route
 * that exists today (/v1/health) already ships without one and no ticket has asked this
 * generator to describe it yet. Later tickets register their own routes as they add them.
 */
export function buildOpenApiDocument(): OpenAPIObject {
  const registry = new OpenAPIRegistry();
  registry.register('HealthResponse', healthResponseSchema);
  registry.register('ErrorEnvelope', errorEnvelopeSchema);

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Bible Artisan API',
      version: '0.0.0',
    },
  });
}
