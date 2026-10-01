'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ApiStatus } from '@/components/api-status';
import { RequireAuth } from '@/components/require-auth';
import { signOut } from '@/lib/auth';

/** Home (authorized). The study list and Continue Studying arrive with later tickets. */
export function Home() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: signOut,
    onSettled: () => {
      // Drop every cached private response before leaving.
      queryClient.clear();
      router.replace('/sign-in');
    },
  });

  return (
    <RequireAuth>
      {(me) => (
        <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
          <h1 className="font-serif text-4xl">Bible Artisan</h1>
          <p className="text-muted">Pick up your study exactly where you left it.</p>
          <div className="flex flex-wrap items-center gap-3">
            <p>Signed in as {me.email}</p>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
            >
              Sign out
            </button>
          </div>
          <ApiStatus />
        </main>
      )}
    </RequireAuth>
  );
}
