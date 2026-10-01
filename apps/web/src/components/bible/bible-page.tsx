'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { RequireAuth } from '@/components/require-auth';
import {
  bibleHref,
  chapterInput,
  fetchTranslations,
  idFromParams,
  resolveReference,
  TRANSLATIONS_QUERY_KEY,
  verseInput,
} from '@/lib/bible';
import { BibleReader, type ChapterTarget, type FocusRequest } from './bible-reader';
import { ReferenceSearch } from './bible-search';

/**
 * `/bible`: reading outside a study (PRD section 9). Records no study events. The URL holds only
 * opaque ids (`?ref=<scripture reference id>&edition=<id>`), so links, reload, and back/forward
 * work while no Scripture reference or search text reaches a URL, history entry, or request log.
 */
export function BiblePage() {
  return <RequireAuth>{() => <BibleWorkspace />}</RequireAuth>;
}

interface OpenRequest {
  editionId: string;
  input: string;
  focus: boolean;
}

const OPEN_FAILED = "We couldn't open that passage.";

function BibleWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [openProblem, setOpenProblem] = useState<string | null>(null);
  const translations = useQuery({ queryKey: TRANSLATIONS_QUERY_KEY, queryFn: fetchTranslations });

  const list = translations.data?.translations ?? [];
  const defaultEditionId = list[0]?.id ?? null;
  const requestedEdition = idFromParams(params, 'edition');
  const translation = list.find((t) => t.id === requestedEdition) ?? list[0];
  const referenceId = idFromParams(params, 'ref');

  const goTo = (id: string | null, editionId: string, focus: boolean) => {
    setOpenProblem(null);
    if (focus && id) setFocusRequest((prev) => ({ referenceId: id, n: (prev?.n ?? 0) + 1 }));
    router.push(bibleHref(id, editionId, defaultEditionId), { scroll: false });
  };

  // Chapters and verses are reached by resolving their text (a request body, never logged), so
  // only the resulting opaque reference id goes in the URL. The current chapter stays on screen
  // until the new one is ready, and a failure is reported with Retry (FR-BIBLE-009).
  const open = useMutation({
    mutationFn: ({ editionId, input }: OpenRequest) => resolveReference(input, editionId),
    onSuccess: (result, { editionId, focus }) => {
      if (result.outcome !== 'resolved') {
        setOpenProblem(OPEN_FAILED);
        return;
      }
      setOpenProblem(null);
      goTo(result.reference.id, editionId, focus);
    },
    onError: () => setOpenProblem(OPEN_FAILED),
  });

  const openChapter = ({ editionId, bookCode, chapter }: ChapterTarget, focus: boolean) => {
    const book = list.find((t) => t.id === editionId)?.books.find((b) => b.code === bookCode);
    if (!book) {
      setOpenProblem('That book is not in this translation.');
      return;
    }
    open.mutate({ editionId, input: chapterInput(book, chapter), focus });
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <nav aria-label="Site">
        <Link href="/" className="text-accent underline">
          Home
        </Link>
      </nav>
      <h1 className="font-serif text-4xl">Bible</h1>

      {translations.isPending ? (
        <p role="status" className="text-muted">
          Loading translations…
        </p>
      ) : null}
      {translations.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>We couldn&apos;t load the Bible translations.</p>
          <button
            type="button"
            onClick={() => void translations.refetch()}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Retry
          </button>
        </div>
      ) : null}
      {translations.isSuccess && !translation ? (
        <p role="alert">No Bible translation is available yet.</p>
      ) : null}
      {requestedEdition && translation && requestedEdition !== translation.id ? (
        <p role="alert">That translation is not available. Showing {translation.name} instead.</p>
      ) : null}

      {translation ? (
        <>
          <ReferenceSearch
            translation={translation}
            onOpenReference={(id) => goTo(id, translation.id, true)}
            onOpenVerse={(bookCode, chapter, verse) => {
              const book = translation.books.find((b) => b.code === bookCode);
              if (book) {
                open.mutate({
                  editionId: translation.id,
                  input: verseInput(book, chapter, verse),
                  focus: true,
                });
              }
            }}
          />
          {open.isPending ? (
            <p role="status" className="text-muted">
              Opening the passage…
            </p>
          ) : null}
          {openProblem ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded border border-accent px-3 py-2"
            >
              <p>{openProblem}</p>
              {open.variables && open.isError ? (
                <button
                  type="button"
                  onClick={() => open.variables && open.mutate(open.variables)}
                  className="rounded border border-accent px-3 py-1 text-accent"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          <BibleReader
            translations={list}
            editionId={translation.id}
            referenceId={referenceId}
            onOpenChapter={openChapter}
            onChangeEdition={(editionId) => goTo(null, editionId, false)}
            focusRequest={focusRequest}
          />
        </>
      ) : null}
    </main>
  );
}
