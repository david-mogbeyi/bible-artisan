'use client';

import {
  REFERENCE_ERROR_CODES,
  type BibleTranslation,
  type ReferenceCandidate,
  type SearchResult,
} from '@bible-artisan/contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { resolveReference, searchBible, type SearchRequest } from '@/lib/bible';
import { Attribution } from './bible-reader';

const REFERENCE_CODES: ReadonlySet<string> = new Set(REFERENCE_ERROR_CODES);

/** Input wrapped in straight or curly double quotes is an exact phrase (PRD section 14). */
const QUOTED = /^["“”](.+)["“”]$/s;

interface ReferenceSearchProps {
  translation: BibleTranslation;
  /** A resolved reference: open its chapter with the range marked. */
  onOpenReference: (referenceId: string) => void;
  /** A search result: open that verse in its chapter. */
  onOpenVerse: (book: string, chapter: number, verse: number) => void;
}

/**
 * One input for references and keywords (PRD sections 11 and 14). A reference is resolved first
 * (`POST /bible/resolve`): resolved opens it, ambiguous offers the books, an invalid reference
 * gets its correction and no keyword results. Only `not_reference` is searched. A quoted phrase
 * or "Exact phrase" is searched literally and never read as a reference. The search text stays
 * in this component's state: never in the URL, local storage, or analytics.
 */
export function ReferenceSearch({
  translation,
  onOpenReference,
  onOpenVerse,
}: ReferenceSearchProps) {
  const inputId = useId();
  const phraseId = useId();
  const bookId = useId();
  const errorId = useId();
  const [input, setInput] = useState('');
  const [exactPhrase, setExactPhrase] = useState(false);
  const [book, setBook] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ReferenceCandidate[] | null>(null);
  const [search, setSearch] = useState<SearchRequest | null>(null);

  const resolve = useMutation({
    mutationFn: (text: string) => resolveReference(text, translation.id),
    onSuccess: (result, text) => {
      if (result.outcome === 'resolved') onOpenReference(result.reference.id);
      else if (result.outcome === 'ambiguous') setCandidates(result.candidates);
      else
        setSearch({ q: text, mode: 'terms', editionId: translation.id, ...(book ? { book } : {}) });
    },
    onError: (error) => {
      setInputError(
        error instanceof ApiError && error.code && REFERENCE_CODES.has(error.code)
          ? `${referenceMessage(error)} Check the reference and try again.`
          : "We couldn't look that up. Try again.",
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    setCandidates(null);
    setInputError(null);
    if (text === '') {
      setInputError('Enter a reference such as Romans 9:1, or words to search for.');
      return;
    }
    const quoted = QUOTED.exec(text);
    if (exactPhrase || quoted) {
      setSearch({
        q: quoted?.[1]?.trim() ?? text,
        mode: 'phrase',
        editionId: translation.id,
        ...(book ? { book } : {}),
      });
      return;
    }
    resolve.mutate(text);
  };

  return (
    <section aria-label="Find a passage" className="flex flex-col gap-3">
      <form role="search" onSubmit={submit} className="flex flex-col gap-2" noValidate>
        <label htmlFor={inputId}>Reference or words to search</label>
        <div className="flex flex-wrap gap-2">
          <input
            id={inputId}
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-invalid={inputError ? true : undefined}
            aria-describedby={inputError ? errorId : undefined}
            autoComplete="off"
            maxLength={200}
            className="min-w-0 flex-1 rounded border border-muted bg-canvas px-3 py-2"
          />
          <button
            type="submit"
            disabled={resolve.isPending}
            className="rounded border border-accent px-4 py-2 text-accent disabled:opacity-60"
          >
            {resolve.isPending ? 'Looking up…' : 'Go'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            <input
              id={phraseId}
              type="checkbox"
              checked={exactPhrase}
              onChange={(event) => setExactPhrase(event.target.checked)}
            />
            <label htmlFor={phraseId}>Exact phrase</label>
          </span>
          <span className="flex items-center gap-2">
            <label htmlFor={bookId}>Search in</label>
            <select
              id={bookId}
              value={book}
              onChange={(event) => setBook(event.target.value)}
              className="rounded border border-muted bg-canvas px-2 py-1"
            >
              <option value="">All books</option>
              {translation.books.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}
                </option>
              ))}
            </select>
          </span>
        </div>
        {inputError ? (
          <p id={errorId} role="alert" className="text-accent">
            {inputError}
          </p>
        ) : null}
      </form>

      {candidates ? (
        <Candidates
          candidates={candidates}
          onPick={(candidate) => {
            setCandidates(null);
            resolve.mutate(candidate.input);
          }}
        />
      ) : null}

      {search ? (
        <SearchResults
          // A new search starts a fresh result list.
          key={`${search.mode}|${search.book ?? ''}|${search.editionId}|${search.q}`}
          request={search}
          translation={translation}
          onOpenReference={onOpenReference}
          onOpenVerse={onOpenVerse}
          onClear={() => setSearch(null)}
          onPickCandidate={(candidate) => resolve.mutate(candidate.input)}
        />
      ) : null}
    </section>
  );
}

function referenceMessage(error: ApiError): string {
  const body = error.body as { message?: unknown } | undefined;
  return typeof body?.message === 'string' ? `${body.message}.` : 'That reference is not valid.';
}

function Candidates({
  candidates,
  onPick,
}: {
  candidates: ReferenceCandidate[];
  onPick: (candidate: ReferenceCandidate) => void;
}) {
  return (
    <div role="group" aria-label="Which book did you mean?" className="flex flex-col gap-2">
      <p>Which book did you mean?</p>
      <ul className="flex flex-wrap gap-2">
        {candidates.map((candidate) => (
          <li key={candidate.bookCode}>
            <button
              type="button"
              onClick={() => onPick(candidate)}
              className="rounded border border-accent px-3 py-1 text-accent"
            >
              {candidate.bookName}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchResults({
  request,
  translation,
  onOpenReference,
  onOpenVerse,
  onClear,
  onPickCandidate,
}: {
  request: SearchRequest;
  translation: BibleTranslation;
  onOpenReference: (referenceId: string) => void;
  onOpenVerse: (book: string, chapter: number, verse: number) => void;
  onClear: () => void;
  onPickCandidate: (candidate: ReferenceCandidate) => void;
}) {
  const headingId = useId();
  const results = useInfiniteQuery({
    queryKey: ['bible', 'search', request] as const,
    queryFn: ({ pageParam }) => searchBible(request, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const pages = results.data?.pages ?? [];
  const items = pages.flatMap((page) => page.results);
  const suggestion = pages[0]?.referenceSuggestion ?? null;
  const modeText = request.mode === 'phrase' ? 'this exact phrase' : 'all of these words';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-serif text-2xl">
          Search results
        </h2>
        <button type="button" onClick={onClear} className="text-sm text-accent underline">
          Clear search
        </button>
      </div>

      {suggestion?.outcome === 'resolved' ? (
        <p>
          <button
            type="button"
            onClick={() => onOpenReference(suggestion.reference.id)}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Open {suggestion.reference.label}
          </button>
        </p>
      ) : null}
      {suggestion?.outcome === 'ambiguous' ? (
        <Candidates candidates={suggestion.candidates} onPick={onPickCandidate} />
      ) : null}

      {results.isPending ? (
        <p role="status" className="text-muted">
          Searching…
        </p>
      ) : null}
      {results.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>We couldn&apos;t search right now.</p>
          <button
            type="button"
            onClick={() => void results.refetch()}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Retry
          </button>
        </div>
      ) : null}
      {results.isSuccess && items.length === 0 ? (
        <p role="status">No verses contain {modeText}.</p>
      ) : null}

      {items.length > 0 ? (
        <>
          <p role="status" className="text-sm text-muted">
            Showing {items.length} {items.length === 1 ? 'verse' : 'verses'} containing {modeText}
            {results.hasNextPage ? ' (more available)' : ''}.
          </p>
          <ol role="list" className="flex flex-col gap-3">
            {items.map((result) => (
              <li
                key={`${result.reference.bookCode} ${result.reference.chapter}:${result.reference.verse}`}
              >
                <button
                  type="button"
                  onClick={() =>
                    onOpenVerse(
                      result.reference.bookCode,
                      result.reference.chapter,
                      result.reference.verse,
                    )
                  }
                  className="font-semibold text-accent underline"
                >
                  {result.reference.label}
                </button>
                <p className="font-serif text-lg">
                  <HighlightedText result={result} />
                </p>
              </li>
            ))}
          </ol>
          {results.hasNextPage ? (
            <button
              type="button"
              onClick={() => void results.fetchNextPage()}
              disabled={results.isFetchingNextPage}
              className="self-start rounded border border-accent px-3 py-2 text-accent disabled:opacity-60"
            >
              {results.isFetchingNextPage ? 'Loading more…' : 'Load more results'}
            </button>
          ) : null}
          <Attribution edition={translation} />
        </>
      ) : null}
    </section>
  );
}

/**
 * The stored verse text with its matches in `<mark>`. Highlights are code-point offsets
 * (BIB-16), so the text is split by code point, never by UTF-16 unit; the text is not altered.
 */
function HighlightedText({ result }: { result: SearchResult }) {
  const points = Array.from(result.text);
  const parts: { text: string; marked: boolean }[] = [];
  let at = 0;
  const sorted = [...result.highlights].sort((a, b) => a.start - b.start);
  for (const h of sorted) {
    if (h.start < at) continue;
    if (h.start > at) parts.push({ text: points.slice(at, h.start).join(''), marked: false });
    parts.push({ text: points.slice(h.start, h.end).join(''), marked: true });
    at = h.end;
  }
  if (at < points.length) parts.push({ text: points.slice(at).join(''), marked: false });
  return (
    <>
      {parts.map((part, i) =>
        part.marked ? (
          <mark key={i} className="bg-transparent font-bold underline">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
