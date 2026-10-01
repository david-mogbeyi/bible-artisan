import { z } from 'zod';

/**
 * Request and response header carrying the request's correlation ID (BIB-13). A client may send
 * a UUID to trace its own request; any other value is replaced. Every /v1 response returns the
 * ID the server used, which is also the error envelope's `correlationId` and appears in the
 * server's log lines for that request.
 */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/**
 * The only error shape a 4xx/5xx JSON body may take from /v1 (PRD §24). The one non-error
 * 5xx body is the readiness probe's 503 `HealthResponse`, a status report for the platform.
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
