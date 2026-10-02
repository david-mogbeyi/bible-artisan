'use client';

import type {
  BibleTranslation,
  ReferenceCandidate,
  SearchBibleResponse,
  SearchResult,
} from '@bible-artisan/contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { classifyError, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import { type ChapterTarget, resolveReference, searchBible, type SearchRequest } from '@/lib/bible';
import { Attribution } from './bible-reader';
import { codePointRuns } from './code-point-runs';
import { ProblemAlert } from './problem-alert';

/** Input wrapped in straight or curly double quotes is an exact phrase (PRD section 14). */
const QUOTED = /^["“”](.+)["“”]$/s;

/**
 * The host's navigation order. `begin` is called when the user starts a navigation and returns
 * its token; `open` applies a resolved reference only if that token is still the latest, so a
 * slow answer never overrides a later choice.
 */
export interface Navigation {
  begin: () => number;
  open: (token: number, referenceId: string) => void;
}

interface ReferenceSearchProps {
  translation: BibleTranslation;
  navigation: Navigation;
  /** A search result: open that verse, in the edition it was found in. */
  onOpenVerse: (target: ChapterTarget) => void;
}

interface ResolveRequest {
  text: string;
  editionId: string;
  token: number;
}

const LOOKUP_COPY = {
  notFound: 'That translation is not available.',
  refused: "We couldn't look that up.",
  unavailable: "We couldn't look that up.",
};
const SEARCH_COPY = {
  notFound: 'That translation is not available.',
  refused: "We couldn't run that search.",
  unavailable: "We couldn't search right now.",
};

/**
 * One input for references and keywords (PRD sections 11 and 14). A reference is resolved first
 * (`POST /bible/resolve`): resolved opens it, ambiguous offers the books, an invalid reference
 * gets its correction and no keyword results. Only `not_reference` is searched. A quoted phrase
 * or "Exact phrase" is searched literally and never read as a reference. The search text stays
 * in this component's state: never in the URL, local storage, or analytics.
 *
 * Search state belongs to the edition it ran in: when the translation changes, results and
 * candidates from the previous edition are dropped, never shown under the new attribution.
 */
export function ReferenceSearch({ translation, navigation, onOpenVerse }: ReferenceSearchProps) {
  const inputId = useId();
  const phraseId = useId();
  const bookId = useId();
  const errorId = useId();
  const [input, setInput] = useState('');
  const [exactPhrase, setExactPhrase] = useState(false);
  const [book, setBook] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [candidateState, setCandidates] = useState<{
    editionId: string;
    list: ReferenceCandidate[];
  } | null>(null);
  const [searchState, setSearch] = useState<SearchRequest | null>(null);
  const search = searchState?.editionId === translation.id ? searchState : null;
  const candidates = candidateState?.editionId === translation.id ? candidateState.list : null;

  // The latest lookup or search submitted here; an older answer is never applied over it.
  const lastLookup = useRef(0);
  const resolve = useMutation({
    mutationFn: ({ text, editionId }: ResolveRequest) => resolveReference(text, editionId),
    onSuccess: (result, { text, editionId, token }) => {
      if (token !== lastLookup.current) return;
      if (result.outcome === 'resolved') navigation.open(token, result.reference.id);
      else if (result.outcome === 'ambiguous') {
        setCandidates({ editionId, list: result.candidates });
      } else setSearch({ q: text, mode: 'terms', editionId, ...(book ? { book } : {}) });
    },
    onError: (error, { token }) => {
      if (token !== lastLookup.current) return;
      const kind = classifyError(error);
      if (kind.kind === 'reference') {
        setInputError(`${REFERENCE_ERROR_COPY[kind.code]} Check the reference and try again.`);
      }
    },
  });
  const lookUp = (text: string) => {
    const token = navigation.begin();
    lastLookup.current = token;
    resolve.mutate({ text, editionId: translation.id, token });
  };
  const lookupFailed =
    resolve.isError && classifyError(resolve.error).kind !== 'reference' ? resolve.error : null;

  const results = useInfiniteQuery({
    queryKey: ['bible', 'search', search] as const,
    queryFn: ({ pageParam }) => {
      if (!search) throw new Error('no search');
      return searchBible(search, pageParam);
    },
    enabled: search !== null,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const pages = search ? (results.data?.pages ?? []) : [];
  const items = pages.flatMap((page) => page.results);
  const modeText = search?.mode === 'phrase' ? 'this exact phrase' : 'all of these words';

  const status = resolve.isPending
    ? 'Looking up…'
    : !search
      ? ''
      : results.isPending
        ? 'Searching…'
        : results.isSuccess && items.length === 0
          ? `No verses contain ${modeText}.`
          : items.length > 0
            ? `Showing ${items.length} ${items.length === 1 ? 'verse' : 'verses'} containing ${modeText}${results.hasNextPage ? ' (more available)' : ''}.`
            : '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    setCandidates(null);
    setInputError(null);
    resolve.reset();
    if (text === '') {
      setInputError('Enter a reference such as Romans 9:1, or words to search for.');
      return;
    }
    const quoted = QUOTED.exec(text);
    if (exactPhrase || quoted) {
      lastLookup.current = 0; // a pending lookup no longer applies
      setSearch({
        q: quoted?.[1]?.trim() ?? text,
        mode: 'phrase',
        editionId: translation.id,
        ...(book ? { book } : {}),
      });
      return;
    }
    lookUp(text);
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
          <button type="submit" className="rounded border border-accent px-4 py-2 text-accent">
            Go
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

      {/* One live region, mounted from the first render; only its text changes. */}
      <p role="status" aria-live="polite" className={status ? 'text-sm text-muted' : 'sr-only'}>
        {status}
      </p>
      {lookupFailed ? (
        <ProblemAlert
          error={lookupFailed}
          copy={LOOKUP_COPY}
          onRetry={() => resolve.variables && lookUp(resolve.variables.text)}
        />
      ) : null}

      {candidates ? (
        <Candidates
          candidates={candidates}
          onPick={(candidate) => {
            setCandidates(null);
            lookUp(candidate.input);
          }}
        />
      ) : null}

      {search ? (
        <section aria-labelledby={`${inputId}-results`} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`${inputId}-results`} className="font-serif text-2xl">
              Search results
            </h2>
            <button
              type="button"
              onClick={() => setSearch(null)}
              className="text-sm text-accent underline"
            >
              Clear search
            </button>
          </div>
          <Suggestion
            pages={pages}
            onOpen={(id) => navigation.open(navigation.begin(), id)}
            onPick={(candidate) => lookUp(candidate.input)}
          />
          {results.isError ? (
            <ProblemAlert
              error={results.error}
              copy={SEARCH_COPY}
              onRetry={() => void results.refetch()}
            />
          ) : null}
          {items.length > 0 ? (
            <>
              <ol role="list" className="flex flex-col gap-3">
                {items.map((result) => (
                  <li
                    key={`${result.reference.bookCode} ${result.reference.chapter}:${result.reference.verse}`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        // The result's own edition and verse, never the reader's current edition.
                        onOpenVerse({
                          editionId: search.editionId,
                          bookCode: result.reference.bookCode,
                          chapter: result.reference.chapter,
                          verse: result.reference.verse,
                        })
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
              {/* `search.editionId` is this translation's id: results are kept per edition. */}
              <Attribution edition={translation} />
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function Suggestion({
  pages,
  onOpen,
  onPick,
}: {
  pages: SearchBibleResponse[];
  onOpen: (referenceId: string) => void;
  onPick: (candidate: ReferenceCandidate) => void;
}) {
  const suggestion = pages[0]?.referenceSuggestion ?? null;
  if (suggestion?.outcome === 'resolved') {
    return (
      <p>
        <button
          type="button"
          onClick={() => onOpen(suggestion.reference.id)}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Open {suggestion.reference.label}
        </button>
      </p>
    );
  }
  if (suggestion?.outcome === 'ambiguous') {
    return <Candidates candidates={suggestion.candidates} onPick={onPick} />;
  }
  return null;
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

/**
 * The stored verse text with its matches in `<mark>`. Highlights are code-point offsets
 * (BIB-16), so the text is split by code point, never by UTF-16 unit; the text is not altered.
 */
function HighlightedText({ result }: { result: SearchResult }) {
  // Overlapping or touching matches read as one marked stretch.
  const parts: { text: string; marked: boolean }[] = [];
  for (const run of codePointRuns(
    result.text,
    result.highlights.map((h) => ({ ...h, key: true })),
  )) {
    const marked = run.keys.length > 0;
    const last = parts[parts.length - 1];
    if (last && last.marked === marked) last.text += run.text;
    else parts.push({ text: run.text, marked });
  }
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
