'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { RequireAuth } from '@/components/require-auth';
import {
  bibleHref,
  type ChapterTarget,
  fetchTranslations,
  referenceFor,
  referenceIdFromParams,
  TRANSLATIONS_QUERY_KEY,
} from '@/lib/bible';
import { BibleReader, type FocusRequest, usePassage } from './bible-reader';
import { type Navigation, ReferenceSearch } from './bible-search';
import { ProblemAlert } from './problem-alert';

/**
 * `/bible`: reading outside a study (PRD section 9). Records no study events. The URL holds only
 * the opaque reference id (`?ref=<scripture reference id>`), which also fixes the edition, so
 * links, bookmarks, reload, and back/forward reopen the same passage in the same edition while no
 * Scripture reference or search text reaches a URL, history entry, or request log.
 */
export function BiblePage() {
  return <RequireAuth>{() => <BibleWorkspace />}</RequireAuth>;
}

interface Pending {
  error: unknown;
  retry: () => void;
}

const OPEN_COPY = {
  notFound: 'That passage is not available.',
  refused: "We couldn't open that passage.",
  unavailable: "We couldn't open that passage.",
};
const TRANSLATIONS_COPY = {
  notFound: 'No Bible translation is available yet.',
  refused: "We couldn't load the Bible translations.",
  unavailable: "We couldn't load the Bible translations.",
};

function BibleWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [opening, setOpening] = useState(false);
  const [openProblem, setOpenProblem] = useState<Pending | null>(null);
  const [chosenEditionId, setChosenEditionId] = useState<string | null>(null);
  const translations = useQuery({ queryKey: TRANSLATIONS_QUERY_KEY, queryFn: fetchTranslations });
  const referenceId = referenceIdFromParams(params);
  const passage = usePassage(referenceId);

  const list = translations.data?.translations ?? [];
  // The open reference fixes the edition; with nothing open, the user's pick or the first one.
  const editionId =
    (referenceId ? passage.data?.edition.id : undefined) ?? chosenEditionId ?? list[0]?.id;
  const translation = list.find((t) => t.id === editionId) ?? list[0];

  /**
   * Navigation order: every navigation the user starts takes the next token, and a result is
   * applied only while its token is still the latest. So when requests overlap, the last one the
   * user initiated wins, whatever order the responses arrive in; nothing is disabled or debounced.
   */
  const latest = useRef(0);
  const begin = (): number => {
    latest.current += 1;
    setOpening(false);
    setOpenProblem(null);
    return latest.current;
  };
  const open = (token: number, id: string, focus: boolean) => {
    if (token !== latest.current) return;
    if (focus) setFocusRequest((prev) => ({ referenceId: id, n: (prev?.n ?? 0) + 1 }));
    router.push(bibleHref(id), { scroll: false });
  };
  const navigation: Navigation = { begin, open: (token, id) => open(token, id, true) };

  /** Asks the API for a chapter's reference (a request body, never logged), then opens it. */
  const openChapter = (target: ChapterTarget, focus: boolean) => {
    const token = begin();
    setOpening(true);
    referenceFor(target).then(
      (reference) => {
        if (token !== latest.current) return;
        setOpening(false);
        open(token, reference.id, focus);
      },
      (error: unknown) => {
        if (token !== latest.current) return;
        setOpening(false);
        setOpenProblem({ error, retry: () => openChapter(target, focus) });
      },
    );
  };

  const status = translations.isPending
    ? 'Loading translations…'
    : opening
      ? 'Opening the passage…'
      : '';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <nav aria-label="Site">
        <Link href="/" className="text-accent underline">
          Home
        </Link>
      </nav>
      <h1 className="font-serif text-4xl">Bible</h1>

      {/* One live region, mounted from the first render; only its text changes. */}
      <p role="status" aria-live="polite" className={status ? 'text-muted' : 'sr-only'}>
        {status}
      </p>
      {translations.isError ? (
        <ProblemAlert
          error={translations.error}
          copy={TRANSLATIONS_COPY}
          onRetry={() => void translations.refetch()}
        />
      ) : null}
      {translations.isSuccess && !translation ? (
        <p role="alert">No Bible translation is available yet.</p>
      ) : null}

      {translation ? (
        <>
          <ReferenceSearch
            translation={translation}
            navigation={navigation}
            onOpenVerse={(target) => openChapter(target, true)}
          />
          {openProblem ? (
            <ProblemAlert error={openProblem.error} copy={OPEN_COPY} onRetry={openProblem.retry} />
          ) : null}
          <BibleReader
            translations={list}
            editionId={translation.id}
            referenceId={referenceId}
            onOpenChapter={openChapter}
            onOpenReference={(id) => open(begin(), id, true)}
            onChangeEdition={(id) => {
              begin();
              setChosenEditionId(id);
            }}
            focusRequest={focusRequest}
          />
        </>
      ) : null}
    </main>
  );
}
