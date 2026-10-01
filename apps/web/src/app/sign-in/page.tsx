import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInForm } from '@/components/sign-in-form';

export const metadata: Metadata = { title: 'Sign in · Bible Artisan' };

export default function SignInPage() {
  // SignInForm reads `?next=` with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
