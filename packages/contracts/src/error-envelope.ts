import { z } from 'zod';

/**
 * The only shape a 4xx/5xx JSON body may take from /v1 (PRD §24).
 * `currentRevision` is present only for 409 stale-revision responses; every other response omits
 * the field entirely (not null) since it is optional here.
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
