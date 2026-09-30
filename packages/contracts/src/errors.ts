import { z } from 'zod';

/**
 * Shared error envelope (PRD section 24). Every 4xx/5xx response from /v1 uses this exact
 * shape. `currentRevision` is present only for a stale-revision 409; omit it (never null)
 * otherwise, since the schema treats it as optional.
 */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  retryable: z.boolean(),
  correlationId: z.string(),
  currentRevision: z.number().int().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
