import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

describe('buildOpenApiDocument', () => {
  it('generates a document containing the error envelope and health schemas', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe('3.0.0');
    const schemas = doc.components?.schemas ?? {};
    expect(schemas).toHaveProperty('HealthResponse');
    expect(schemas).toHaveProperty('ErrorEnvelope');
    expect(doc.paths).toHaveProperty('/health');
  });
});
