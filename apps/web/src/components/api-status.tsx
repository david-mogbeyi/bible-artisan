'use client';

import { healthResponseSchema } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export function ApiStatus() {
  const { data, isError, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch('/health', healthResponseSchema),
  });

  const label = isPending
    ? 'Checking API…'
    : isError
      ? 'API unreachable'
      : `API ${data.status} · database ${data.database}`;

  return (
    <p role="status" className="text-sm text-muted">
      {label}
    </p>
  );
}
