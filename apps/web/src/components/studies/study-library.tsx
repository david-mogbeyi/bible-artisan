'use client';

import {
  hasForbiddenUserTextCharacter,
  LIBRARY_QUERY_TOO_MANY_WORDS,
  MAX_LIBRARY_QUERY_LENGTH,
  MAX_LIBRARY_QUERY_TOKENS,
  type StudyListItem,
  type StudySort,
  studySearchTokens,
  USER_TEXT_INVALID_CHARACTERS,
} from '@bible-artisan/contracts';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { RequireAuth } from '@/components/require-auth';
import { classifyError } from '@/lib/api-errors';
import { type LibraryRequest, libraryQueryKey, listStudies, studyHref } from '@/lib/studies';

const LOAD_COPY: ProblemCopy = {
  notFound: "Couldn't load your studies.",
  refused: "Couldn't load your studies.",
  unavailable: "Couldn't load your studies.",
};
const MORE_COPY: ProblemCopy = {
  notFound: "Couldn't load more studies.",
  refused: "Couldn't load more studies.",
  unavailable: "Couldn't load more studies.",
};

const SORT_LABELS: Record<StudySort, string> = {
  recent: 'Recent activity',
  created: 'Date created',
  title: 'Title',
};

interface Filters {
  q: string | null;
  tag: { id: string; name: string } | null;
  sort: StudySort;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * `/studies` (BIB-21, FR-STUDY-004): the signed-in user's own studies, pinned first, searchable by
 * title, description and tag, filterable by a tag, sortable, in pages of 50 with Load more.
 *
 * Privacy (PRD section 9): the search text and the tag filter live in component state only. They
 * never go into the page URL, browser history or localStorage, and TanStack Query holds them
 * only in memory.
 */
export function StudyLibraryPage() {
  return <RequireAuth>{() => <StudyLibrary />}</RequireAuth>;
}

function StudyLibrary() {
  const queryClient = useQueryClient();
  const inputId = useId();
  const sortId = useId();
  const errorId = useId();
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ q: null, tag: null, sort: 'recent' });
  const [announcement, setAnnouncement] = useState('');
  // When the last page arrives, Load more disappears; focus moves to the first study it added,
  // so a keyboard user is not left on the page body.
  const focusStudyId = useRef<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  /** Focuses the pending study once its link is rendered (whichever comes first: this or the commit). */
  const focusPendingStudy = () => {
    const id = focusStudyId.current;
    if (id === null) return;
    const link = resultsRef.current?.querySelector<HTMLElement>(`[data-study-id="${id}"]`);
    if (!link) return;
    focusStudyId.current = null;
    link.focus();
  };

  const request: LibraryRequest = {
    sort: filters.sort,
    ...(filters.q !== null ? { q: filters.q } : {}),
    ...(filters.tag !== null ? { tagId: filters.tag.id } : {}),
  };
  const queryKey = libraryQueryKey(request);
  const list = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => listStudies(request, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Loading never blanks saved content (PRD section 11): the previous results stay until the
    // new ones arrive.
    placeholderData: keepPreviousData,
  });

  const filtered = filters.q !== null || filters.tag !== null;
  const clearFilters = () => {
    setInput('');
    setInputError(null);
    setFilters((current) => ({ ...current, q: null, tag: null }));
    setAnnouncement('Filters cleared.');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    setInputError(null);
    // PRD section 11: "Empty search resets filters".
    if (text === '' || studySearchTokens(text).length === 0) {
      clearFilters();
      return;
    }
    if (hasForbiddenUserTextCharacter(text)) {
      setInputError(USER_TEXT_INVALID_CHARACTERS);
      return;
    }
    if (studySearchTokens(text).length > MAX_LIBRARY_QUERY_TOKENS) {
      setInputError(LIBRARY_QUERY_TOO_MANY_WORDS);
      return;
    }
    setFilters((current) => ({ ...current, q: text }));
  };

  const loadMore = async () => {
    const result = await list.fetchNextPage();
    if (result.isError) {
      // A cursor the server no longer accepts (400): start the list over rather than guess.
      if (classifyError(result.error).kind === 'refused') {
        setAnnouncement('Your studies changed. Showing the list from the start.');
        await queryClient.resetQueries({ queryKey, exact: true });
      }
      return;
    }
    const added = result.data?.pages.at(-1)?.items ?? [];
    setAnnouncement(`${added.length} more ${added.length === 1 ? 'study' : 'studies'} loaded.`);
    const first = added[0];
    if (!result.hasNextPage && first) {
      focusStudyId.current = first.id;
      focusPendingStudy();
    }
  };

  useEffect(focusPendingStudy, [list.data]);

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const pinned = items.filter((item) => item.pinned);
  const others = items.filter((item) => !item.pinned);
  const filterByTag = (tag: { id: string; name: string }) => {
    setFilters((current) => ({ ...current, tag }));
    setAnnouncement(`Showing studies tagged ${tag.name}.`);
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl">Your studies</h1>
        <nav aria-label="Library" className="flex flex-wrap gap-4">
          <Link href="/studies/new" className="text-accent underline">
            New study
          </Link>
          <Link href="/" className="text-accent underline">
            Home
          </Link>
        </nav>
      </div>

      <div className="flex flex-col gap-3">
        <form role="search" onSubmit={submit} className="flex flex-col gap-2" noValidate>
          <label htmlFor={inputId}>Search titles, descriptions and tags</label>
          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              type="search"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? errorId : undefined}
              autoComplete="off"
              maxLength={MAX_LIBRARY_QUERY_LENGTH}
              className="min-w-0 flex-1 rounded border border-muted bg-canvas px-3 py-2"
            />
            <button type="submit" className="rounded border border-accent px-4 py-2 text-accent">
              Search
            </button>
          </div>
          {inputError ? (
            <p id={errorId} className="text-ink">
              {inputError}
            </p>
          ) : null}
        </form>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={sortId}>Sort by</label>
          <select
            id={sortId}
            value={filters.sort}
            onChange={(event) =>
              setFilters((current) => ({ ...current, sort: event.target.value as StudySort }))
            }
            className="rounded border border-muted bg-canvas px-2 py-1"
          >
            {(Object.keys(SORT_LABELS) as StudySort[]).map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </select>
          {filters.tag ? (
            <p className="flex items-center gap-2">
              <span>Tag: {filters.tag.name}</span>
              <button
                type="button"
                onClick={() => {
                  setFilters((current) => ({ ...current, tag: null }));
                  setAnnouncement('Tag filter cleared.');
                }}
                className="rounded border border-accent px-2 py-0.5 text-accent"
              >
                Clear tag filter
              </button>
            </p>
          ) : null}
          {filtered ? (
            <button type="button" onClick={clearFilters} className="text-accent underline">
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      {list.isError && list.isRefetchError && list.data ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded border border-accent px-3 py-2"
        >
          <p>
            Couldn&apos;t refresh. Showing results from {timeFormat.format(list.dataUpdatedAt)}.
          </p>
          <button
            type="button"
            onClick={() => void list.refetch()}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Retry
          </button>
        </div>
      ) : null}

      {list.data ? (
        <section
          ref={resultsRef}
          aria-label="Studies"
          aria-busy={list.isPlaceholderData || list.isFetching ? true : undefined}
          className="flex flex-col gap-6"
        >
          {list.isPlaceholderData ? <p className="text-muted">Updating…</p> : null}
          {items.length === 0 ? (
            filtered ? (
              <div className="flex flex-col items-start gap-2">
                <p>No studies match.</p>
                <button type="button" onClick={clearFilters} className="text-accent underline">
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p>No studies yet.</p>
                <Link href="/studies/new" className="text-accent underline">
                  Start a new study
                </Link>
              </div>
            )
          ) : null}
          {pinned.length > 0 ? (
            <StudyGroup heading="Pinned" items={pinned} onTag={filterByTag} />
          ) : null}
          {others.length > 0 ? (
            <StudyGroup
              heading={pinned.length > 0 ? 'Other studies' : 'Studies'}
              items={others}
              onTag={filterByTag}
            />
          ) : null}
          {list.isFetchNextPageError ? (
            <ProblemAlert error={list.error} copy={MORE_COPY} onRetry={() => void loadMore()} />
          ) : null}
          {list.hasNextPage ? (
            <button
              type="button"
              aria-disabled={list.isFetchingNextPage ? true : undefined}
              onClick={() => {
                if (!list.isFetchingNextPage) void loadMore();
              }}
              className="self-start rounded border border-accent px-4 py-2 text-accent aria-disabled:opacity-60"
            >
              {list.isFetchingNextPage ? 'Loading more…' : 'Load more'}
            </button>
          ) : null}
        </section>
      ) : list.isError ? (
        <ProblemAlert error={list.error} copy={LOAD_COPY} onRetry={() => void list.refetch()} />
      ) : (
        <div aria-busy="true" className="flex flex-col gap-3">
          <p className="text-muted">Loading your studies…</p>
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              aria-hidden="true"
              className="h-16 rounded border border-muted opacity-40"
            />
          ))}
        </div>
      )}
    </main>
  );
}

function StudyGroup({
  heading,
  items,
  onTag,
}: {
  heading: string;
  items: StudyListItem[];
  onTag: (tag: { id: string; name: string }) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-serif text-2xl">
        {heading}
      </h2>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1 rounded border border-muted px-4 py-3">
            <Link
              href={studyHref(item.id)}
              data-study-id={item.id}
              className="break-words text-lg text-accent underline"
            >
              {item.title}
            </Link>
            <p className="text-muted">
              {item.pinned ? 'Pinned · ' : ''}
              {item.startingReference ? `${item.startingReference.label} · ` : ''}
              Last activity {dateFormat.format(new Date(item.lastActivityAt))}
            </p>
            {item.tags.length > 0 ? (
              <ul aria-label="Tags" className="flex flex-wrap gap-2">
                {item.tags.map((tag) => (
                  <li key={tag.id}>
                    <button
                      type="button"
                      aria-label={`Filter by tag ${tag.name}`}
                      onClick={() => onTag(tag)}
                      className="rounded-full border border-muted px-2 py-0.5 text-sm"
                    >
                      {tag.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
