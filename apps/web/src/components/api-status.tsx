'use client';

import { type HealthResponse, healthResponseSchema } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * Readiness through `apiFetch`. A degraded API answers 503 with the same health body (a probe
 * report, not the error envelope), so that body is the answer, not a failure. Anything else that
 * fails (network error, another status, a body that isn't a health report) means unreachable.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  try {
    return await apiFetch('/health', healthResponseSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      const report = healthResponseSchema.safeParse(error.body);
      if (report.success) return report.data;
    }
    throw error;
  }
}

/** One line of status text: what is up, and when degraded, which check failed. */
function healthLabel(health: HealthResponse): string {
  const parts = [`API ${health.status}`, `database ${health.database}`];
  if (health.migrations !== 'current') parts.push(`migrations ${health.migrations}`);
  return parts.join(' · ');
}

export function ApiStatus() {
  const { data, isError, isPending } = useQuery({ queryKey: ['health'], queryFn: fetchHealth });

  const label = isPending ? 'Checking API…' : isError ? 'API unreachable' : healthLabel(data);

  return (
    <p role="status" className="text-sm text-muted">
      {label}
    </p>
  );
}
