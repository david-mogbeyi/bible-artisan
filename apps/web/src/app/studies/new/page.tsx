import type { Metadata } from 'next';
import { NewStudyPage } from '@/components/studies/new-study-form';

export const metadata: Metadata = { title: 'New study · Bible Artisan' };

export default function NewStudyRoute() {
  return <NewStudyPage />;
}
