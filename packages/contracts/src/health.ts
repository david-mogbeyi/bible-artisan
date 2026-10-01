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
 * `GET /v1/health` (readiness): 200 with `status: 'ok'` only when PostgreSQL answers, every
 * migration shipped with this build is applied, and the Bible corpus release this build pins is
 * imported and active; otherwise 503 with `status: 'unavailable'`, so a deployment platform marks
 * the release unhealthy. `migrations` and `corpus` are `unknown` when the database could not be
 * asked (or, for `corpus`, its tables do not exist yet). Carries check states only: no versions,
 * hosts, or error text.
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  database: z.enum(['up', 'down']),
  migrations: z.enum(['current', 'pending', 'unknown']),
  corpus: z.enum(['ready', 'missing', 'unknown']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
