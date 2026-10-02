import type { Metadata } from 'next';
import { Suspense } from 'react';
import { StudyPage } from '@/components/studies/study-page';

// A fixed title: the study's own title is private and stays out of the document head.
export const metadata: Metadata = { title: 'Study · Bible Artisan' };

export default function StudyRoute() {
  // StudyPage reads `?node=` with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <StudyPage />
    </Suspense>
  );
}
