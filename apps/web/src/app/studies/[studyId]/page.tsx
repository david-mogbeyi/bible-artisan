import type { Metadata } from 'next';
import { StudyPage } from '@/components/studies/study-page';

// A fixed title: the study's own title is private and stays out of the document head.
export const metadata: Metadata = { title: 'Study · Bible Artisan' };

export default function StudyRoute() {
  return <StudyPage />;
}
