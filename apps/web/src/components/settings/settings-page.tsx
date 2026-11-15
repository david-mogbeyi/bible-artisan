'use client';

import Link from 'next/link';
import { RequireAuth } from '@/components/require-auth';
import { AccountDataSettings } from './account-data-settings';
import { AiConsentSettings } from './ai-consent-settings';

/** Account settings (authorized). AI consent arrived with BIB-40; export and deletion with BIB-48. */
export function SettingsPage() {
  return (
    <RequireAuth>
      {(me) => (
        <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
          <nav aria-label="Breadcrumb">
            <Link href="/" className="text-accent underline">
              Home
            </Link>
          </nav>
          <h1 className="font-serif text-4xl">Settings</h1>
          <AiConsentSettings />
          <AccountDataSettings me={me} />
        </main>
      )}
    </RequireAuth>
  );
}
