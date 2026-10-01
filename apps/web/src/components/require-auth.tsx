'use client';

import type { MeResponse } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ApiError } from '@/lib/api-client';
import { fetchMe, ME_QUERY_KEY } from '@/lib/auth';

const isUnauthenticated = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

/**
 * Wraps an authorized route (FR-AUTH-001). Asks the API who is signed in; on 401 it sends the
 * visitor to sign-in with the current path as `next`, so they come back here afterwards.
 */
export function RequireAuth({ children }: { children: (me: MeResponse) => ReactNode }) {
  const router = useRouter();
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    retry: (failureCount, error) => !isUnauthenticated(error) && failureCount < 1,
  });

  const unauthenticated = isUnauthenticated(me.error);
  useEffect(() => {
    if (!unauthenticated) return;
    const next = `${window.location.pathname}${window.location.search}`;
    router.replace(`/sign-in?next=${encodeURIComponent(next)}`);
  }, [unauthenticated, router]);

  if (me.data) return <>{children(me.data)}</>;

  if (me.isError && !unauthenticated) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16">
        <p role="alert">We couldn&apos;t check your session.</p>
        <button
          type="button"
          onClick={() => void me.refetch()}
          className="self-start rounded border border-accent px-4 py-2 text-accent"
        >
          Retry
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <p role="status" className="text-muted">
        Checking your session…
      </p>
    </main>
  );
}
