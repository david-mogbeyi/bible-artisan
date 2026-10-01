import type { Metadata } from 'next';
import { StudyLibraryPage } from '@/components/studies/study-library';

export const metadata: Metadata = { title: 'Your studies · Bible Artisan' };

export default function StudiesRoute() {
  return <StudyLibraryPage />;
}
