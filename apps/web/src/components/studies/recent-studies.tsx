'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useId } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { type LibraryRequest, libraryQueryKey, listStudies, studyHref } from '@/lib/studies';

const COPY: ProblemCopy = {
  notFound: "Couldn't load your recent studies.",
  refused: "Couldn't load your recent studies.",
  unavailable: "Couldn't load your recent studies.",
};

/** PRD section 11 (Home): three recent studies. Pinned studies come first, as in the library. */
const RECENT: LibraryRequest = { sort: 'recent', limit: 3 };

/**
 * Home's "Recent studies" (BIB-21): the first three of the library's default order, each a link,
 * plus a link to the whole library. Its errors stay inside this section (PRD section 11: errors
 * are scoped to the failed component). Continue Studying and the resume card are BIB-34's.
 */
export function RecentStudies() {
  const headingId = useId();
  const recent = useQuery({
    queryKey: libraryQueryKey(RECENT),
    queryFn: () => listStudies(RECENT, null),
  });
  const items = recent.data?.items ?? [];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-serif text-2xl">
        Recent studies
      </h2>
      {recent.data ? (
        items.length === 0 ? (
          <p className="text-muted">No studies yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <Link href={studyHref(item.id)} className="break-words text-accent underline">
                  {item.title}
                </Link>
                {item.pinned ? <span className="text-muted"> · Pinned</span> : null}
              </li>
            ))}
          </ul>
        )
      ) : recent.isError ? (
        <ProblemAlert error={recent.error} copy={COPY} onRetry={() => void recent.refetch()} />
      ) : (
        <p aria-busy="true" className="text-muted">
          Loading recent studies…
        </p>
      )}
      <Link href="/studies" className="self-start text-accent underline">
        All studies
      </Link>
    </section>
  );
}
