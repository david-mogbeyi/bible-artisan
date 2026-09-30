import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Side-effect only: patches `.openapi(...)` onto the Zod prototype. Must be imported (and must
// execute) before any schema this package's other files construct, since zod v4 binds this
// method at construction time rather than through prototype lookup alone. Kept in its own file,
// imported first, so ESM's "siblings run in source order" rule (not hoisting) guarantees the
// patch lands before `./health` or `./error-envelope` ever call `z.object(...)`.
extendZodWithOpenApi(z);
