import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BiblePage } from '@/components/bible/bible-page';

export const metadata: Metadata = { title: 'Bible · Bible Artisan' };

export default function BibleRoute() {
  // BiblePage reads the passage from the URL with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <BiblePage />
    </Suspense>
  );
}
