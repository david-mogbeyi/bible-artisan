import type { Metadata } from 'next';
import { SettingsPage } from '@/components/settings/settings-page';

export const metadata: Metadata = { title: 'Settings · Bible Artisan' };

export default function SettingsRoute() {
  return <SettingsPage />;
}
