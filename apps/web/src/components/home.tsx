'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiStatus } from '@/components/api-status';
import { RequireAuth } from '@/components/require-auth';
import { ContinueStudying } from '@/components/studies/continue-studying';
import { RecentStudies } from '@/components/studies/recent-studies';
import { signOut } from '@/lib/auth';
import { clearLocalAccountData } from '@/lib/exports';
import { downloadDrafts, entryDrafts, listQueued, type QueuedNoteSave } from '@/lib/offline-queue';

const SIGN_OUT_ERROR = "You're still signed in. Something went wrong signing out. Try again.";

export const SIGN_OUT_UNSYNCED = (count: number) =>
  `${count} offline note ${count === 1 ? "edit hasn't" : "edits haven't"} synced yet. Signing out removes ${count === 1 ? 'it' : 'them'} from this browser, so download ${count === 1 ? 'it' : 'them'} first to keep a copy.`;

/**
 * Home (authorized). New Study starts one (BIB-19); Recent studies and the library link come from
 * BIB-21; Continue studying (the deterministic resume card) is BIB-34's.
 */
export function Home() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Bumped on every failure so a repeated failure still moves focus to the alert.
  const [errorCount, setErrorCount] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);

  // Unsynced offline edits found when Sign out was chosen (BIB-36): offered as a download first.
  const [unsynced, setUnsynced] = useState<QueuedNoteSave[] | null>(null);

  const logout = useMutation({
    mutationFn: signOut,
    // Only a confirmed logout counts as signed out: if the request failed, the session may still
    // be live, so the user stays here and is told, rather than being shown a sign-in page.
    onSuccess: async () => {
      // Drop every cached private response, and this browser's private storage and offline
      // queue, before leaving: a shared browser shows the next account nothing (PRD section 27).
      queryClient.clear();
      await clearLocalAccountData();
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
          <nav aria-label="Main" className="flex flex-wrap gap-4">
            <Link href="/studies/new" className="text-accent underline">
              New study
            </Link>
            <Link href="/studies" className="text-accent underline">
              Your studies
            </Link>
            <Link href="/bible" className="text-accent underline">
              Read the Bible
            </Link>
            <Link href="/settings" className="text-accent underline">
              Settings
            </Link>
          </nav>
          <ContinueStudying />
          <RecentStudies />
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
              onClick={() => {
                void listQueued(me.id).then((queued) => {
                  if (queued.length > 0) setUnsynced(queued);
                  else logout.mutate();
                });
              }}
              disabled={logout.isPending}
              className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
            >
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {unsynced ? (
            <section
              aria-label="Unsynced edits"
              className="flex flex-col gap-2 rounded border border-accent p-3"
            >
              <p role="alert">{SIGN_OUT_UNSYNCED(unsynced.length)}</p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => downloadDrafts(entryDrafts(unsynced))}
                  className="text-accent underline"
                >
                  Download unsynced drafts
                </button>
                <button
                  type="button"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                  className="text-accent underline"
                >
                  Sign out anyway
                </button>
                <button
                  type="button"
                  onClick={() => setUnsynced(null)}
                  className="text-accent underline"
                >
                  Stay signed in
                </button>
              </div>
            </section>
          ) : null}
          <ApiStatus />
        </main>
      )}
    </RequireAuth>
  );
}
