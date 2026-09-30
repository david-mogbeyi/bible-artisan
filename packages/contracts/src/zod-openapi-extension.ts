import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * Side-effect-only module, imported first (before any line that defines a schema) by
 * index.ts. `.openapi()` is patched onto zod's schema classes at call time and does not
 * retroactively apply to already-constructed schema instances, so this must run before
 * any schema literal in this package (health.ts, errors.ts, ...) executes — not just
 * before the consumer that happens to generate the OpenAPI document.
 */
extendZodWithOpenApi(z);
