import { ApiStatus } from '@/components/api-status';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="font-serif text-4xl">Bible Artisan</h1>
      <p className="text-muted">Pick up your study exactly where you left it.</p>
      <ApiStatus />
    </main>
  );
}
