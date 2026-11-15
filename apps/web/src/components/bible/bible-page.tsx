'use client';

import type { VisitOrigin } from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { RequireAuth } from '@/components/require-auth';
import {
  bibleHref,
  type ChapterTarget,
  fetchTranslations,
  fromEventIdFromParams,
  referenceFor,
  referenceIdFromParams,
  studyIdFromParams,
  TRANSLATIONS_QUERY_KEY,
} from '@/lib/bible';
import { fetchStudy, studyQueryKey } from '@/lib/studies';
import { useEndSessionOnLeave } from '@/lib/study-session';
import { invalidateThread, recordActivity } from '@/lib/thread';
import { patchViewState } from '@/lib/view-revision';
import { BibleReader, type FocusRequest, usePassage } from './bible-reader';
import { type Navigation, ReferenceSearch } from './bible-search';
import { ProblemAlert } from './problem-alert';

/**
 * `/bible`: reading outside a study (PRD section 9), or in one (`&study=<study id>`, BIB-24: its
 * highlights are drawn and can be added, and a selection can be noted). Reading outside a study
 * records nothing. In an active study (BIB-55), each deliberate navigation records one visit
 * once its text has loaded, with its true origin (search, a reader link, an earlier thread event
 * via `&from=<event id>`, or a direct open) and the previous visit as its parent. A reload,
 * back/forward restoration or re-render records nothing. The URL holds only opaque ids (`?ref=<scripture reference id>`, which also fixes the
 * edition), so links, bookmarks, reload, and back/forward reopen the same passage in the same
 * edition while no Scripture reference, search text, quote or label reaches a URL, history entry,
 * or request log.
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
const STUDY_COPY = {
  notFound: "This study isn't available. You can still read here.",
  refused: "We couldn't open this study. You can still read here.",
  unavailable: "We couldn't load this study. You can still read here.",
};
const TRANSLATIONS_COPY = {
  notFound: 'No Bible translation is available yet.',
  refused: "We couldn't load the Bible translations.",
  unavailable: "We couldn't load the Bible translations.",
};

interface PendingVisit {
  referenceId: string;
  origin: VisitOrigin;
}

/**
 * True for the first workspace mount after the document itself was reloaded: restoring the page
 * is not a deliberate visit (PRD section 13). Later mounts in the same document are navigations.
 */
let documentMounted = false;
function isReloadRestore(): boolean {
  const first = !documentMounted;
  documentMounted = true;
  if (!first || typeof performance === 'undefined') return false;
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type === 'reload' || entry?.type === 'back_forward';
}

function BibleWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [opening, setOpening] = useState(false);
  const [openProblem, setOpenProblem] = useState<Pending | null>(null);
  const [chosenEditionId, setChosenEditionId] = useState<string | null>(null);
  const translations = useQuery({ queryKey: TRANSLATIONS_QUERY_KEY, queryFn: fetchTranslations });
  const referenceId = referenceIdFromParams(params);
  const studyId = studyIdFromParams(params);
  const fromEventId = fromEventIdFromParams(params);
  const passage = usePassage(referenceId);
  const [pendingVisit, setPendingVisit] = useState<PendingVisit | null>(() =>
    referenceId && studyId && !isReloadRestore()
      ? {
          referenceId,
          origin: fromEventId ? { kind: 'event', eventId: fromEventId } : { kind: 'direct' },
        }
      : null,
  );
  const lastVisitEventId = useRef<string | null>(null);
  /** The pending visit already sent, so each deliberate navigation is recorded once. */
  const sentVisit = useRef<PendingVisit | null>(null);
  const study = useQuery({
    queryKey: studyId ? studyQueryKey(studyId) : ['studies', 'none'],
    queryFn: () => {
      if (!studyId) throw new Error('no study');
      return fetchStudy(studyId);
    },
    enabled: studyId !== null,
  });

  const list = translations.data?.translations ?? [];
  // The open reference fixes the edition; with nothing open, the user's pick or the first one.
  const editionId =
    (referenceId ? passage.data?.edition.id : undefined) ?? chosenEditionId ?? list[0]?.id;
  const translation = list.find((t) => t.id === editionId) ?? list[0];

  // BIB-55: record the pending deliberate visit once its passage text has loaded.
  const loaded = passage.isSuccess && !passage.isPlaceholderData;
  const studyActive = study.data?.lifecycle === 'active';
  // BIB-33: leaving the study (not just for its own page) ends this tab's session in it.
  useEndSessionOnLeave(studyId, studyActive);
  useEffect(() => {
    if (!pendingVisit || sentVisit.current === pendingVisit) return;
    if (!studyId || !studyActive || !loaded || pendingVisit.referenceId !== referenceId) return;
    sentVisit.current = pendingVisit;
    const visited = pendingVisit.referenceId;
    recordActivity(studyId, {
      kind: 'visit',
      clientMutationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      referenceId: pendingVisit.referenceId,
      origin: pendingVisit.origin,
      parentVisitEventId: lastVisitEventId.current,
    }).then(
      (recorded) => {
        lastVisitEventId.current = recorded.eventId;
        void invalidateThread(queryClient, studyId);
        // BIB-34: where to reopen the reader in this study, saved after the visit (best effort).
        patchViewState(queryClient, studyId, { readerReferenceId: visited }).catch(() => undefined);
      },
      // Capture is best effort: a failed visit never blocks reading (the offline queue, BIB-36,
      // will retry it).
      () => undefined,
    );
  }, [pendingVisit, studyId, studyActive, loaded, referenceId, queryClient]);

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
  // Back/Forward changes the URL without going through `open`; it supersedes any pending lookup.
  const pushedReferenceId = useRef(referenceId);
  useEffect(() => {
    if (referenceId === pushedReferenceId.current) return;
    pushedReferenceId.current = referenceId;
    latest.current += 1;
    setOpening(false);
  }, [referenceId]);

  const open = (token: number, id: string, focus: boolean, origin: VisitOrigin) => {
    if (token !== latest.current) return;
    if (focus) setFocusRequest((prev) => ({ referenceId: id, n: (prev?.n ?? 0) + 1 }));
    pushedReferenceId.current = id;
    setPendingVisit({ referenceId: id, origin });
    router.push(bibleHref(id, studyId), { scroll: false });
  };
  const SEARCH: VisitOrigin = { kind: 'search' };
  const fromReader = (): VisitOrigin =>
    referenceId ? { kind: 'reader', referenceId } : { kind: 'reader' };
  const navigation: Navigation = { begin, open: (token, id) => open(token, id, true, SEARCH) };

  /** Asks the API for a chapter's reference (a request body, never logged), then opens it. */
  const openChapter = (target: ChapterTarget, focus: boolean, origin: VisitOrigin) => {
    const token = begin();
    setOpening(true);
    referenceFor(target).then(
      (reference) => {
        if (token !== latest.current) return;
        setOpening(false);
        open(token, reference.id, focus, origin);
      },
      (error: unknown) => {
        if (token !== latest.current) return;
        setOpening(false);
        setOpenProblem({ error, retry: () => openChapter(target, focus, origin) });
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
      {studyId ? (
        study.data ? (
          <p>
            Reading in the study{' '}
            <Link href={`/studies/${study.data.id}`} className="text-accent underline">
              {study.data.title}
            </Link>
            . Your highlights in it are shown on the text.
          </p>
        ) : study.isError ? (
          <ProblemAlert
            error={study.error}
            copy={STUDY_COPY}
            onRetry={() => void study.refetch()}
          />
        ) : null
      ) : null}

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
            onOpenVerse={(target) => openChapter(target, true, SEARCH)}
          />
          {openProblem ? (
            <ProblemAlert error={openProblem.error} copy={OPEN_COPY} onRetry={openProblem.retry} />
          ) : null}
          <BibleReader
            translations={list}
            editionId={translation.id}
            referenceId={referenceId}
            onOpenChapter={(target, focus) => openChapter(target, focus, fromReader())}
            onOpenReference={(id) => open(begin(), id, true, fromReader())}
            onChangeEdition={(id) => {
              begin();
              setChosenEditionId(id);
            }}
            focusRequest={focusRequest}
            study={study.data ?? null}
          />
        </>
      ) : null}
    </main>
  );
}
