import { z } from 'zod';

/**
 * `GET /v1/health/live` (liveness): the process serves HTTP. Never touches the database, so a
 * database outage does not get a healthy API process restarted.
 */
export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

/**
 * `GET /v1/health` (readiness): 200 with `status: 'ok'` only when PostgreSQL answers and every
 * migration shipped with this build is applied; otherwise 503 with `status: 'unavailable'`, so a
 * deployment platform marks the release unhealthy. `migrations` is `unknown` when the database
 * could not be asked. Carries check states only: no versions, hosts, or error text.
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  database: z.enum(['up', 'down']),
  migrations: z.enum(['current', 'pending', 'unknown']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
