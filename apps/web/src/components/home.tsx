'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiStatus } from '@/components/api-status';
import { RequireAuth } from '@/components/require-auth';
import { signOut } from '@/lib/auth';

const SIGN_OUT_ERROR = "You're still signed in. Something went wrong signing out. Try again.";

/** Home (authorized). The study list and Continue Studying arrive with later tickets. */
export function Home() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Bumped on every failure so a repeated failure still moves focus to the alert.
  const [errorCount, setErrorCount] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const logout = useMutation({
    mutationFn: signOut,
    // Only a confirmed logout counts as signed out: if the request failed, the session may still
    // be live, so the user stays here and is told, rather than being shown a sign-in page.
    onSuccess: () => {
      // Drop every cached private response before leaving.
      queryClient.clear();
      router.replace('/sign-in');
    },
    onError: () => setErrorCount((count) => count + 1),
  });

  useEffect(() => {
    if (errorCount > 0) errorRef.current?.focus();
  }, [errorCount]);

  return (
    <RequireAuth>
      {(me) => (
        <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
          <h1 className="font-serif text-4xl">Bible Artisan</h1>
          <p className="text-muted">Pick up your study exactly where you left it.</p>
          {logout.isError ? (
            <div
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="rounded border border-accent px-3 py-2 text-ink"
            >
              {SIGN_OUT_ERROR}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p>Signed in as {me.email}</p>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
            >
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          <ApiStatus />
        </main>
      )}
    </RequireAuth>
  );
}
