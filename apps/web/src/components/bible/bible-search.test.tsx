import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, EDITION_ID, OTHER_TRANSLATION, TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { ReferenceSearch } from './bible-search';

type Handler = (url: URL, body: unknown) => Response | Promise<Response>;
let resolveHandler: Handler;
let searchHandler: Handler;
let fetchMock: ReturnType<typeof vi.fn>;

const fail = (): Response => {
  throw new Error('unexpected request');
};

beforeEach(() => {
  resolveHandler = fail;
  searchHandler = fail;
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname.endsWith('/bible/resolve')) return Promise.resolve(resolveHandler(url, body));
    if (url.pathname.endsWith('/bible/search')) return Promise.resolve(searchHandler(url, body));
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (path: string) =>
  (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([input]) =>
    new URL(input).pathname.endsWith(path),
  );

function renderSearch() {
  let tokens = 0;
  const navigation = { begin: vi.fn(() => ++tokens), open: vi.fn() };
  const onOpenVerse = vi.fn();
  const view = renderWithQuery(
    <ReferenceSearch translation={TRANSLATION} navigation={navigation} onOpenVerse={onOpenVerse} />,
  );
  /** Opened references, by id, with the token their lookup was given. */
  const onOpenReference = navigation.open;
  const switchTo = (translation: typeof TRANSLATION) =>
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <ReferenceSearch
          translation={translation}
          navigation={navigation}
          onOpenVerse={onOpenVerse}
        />
      </QueryClientProvider>,
    );
  return { onOpenReference, onOpenVerse, navigation, switchTo };
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'Server wording that must never be shown',
  retryable: false,
  correlationId: 'c',
  ...extra,
});

function submit(text: string) {
  fireEvent.change(screen.getByLabelText('Reference or words to search'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
}

const REFERENCE = {
  id: '11111111-2222-4333-8444-555555555555',
  editionId: EDITION_ID,
  bookCode: 'PSA',
  startChapter: 3,
  startVerse: 1,
  endChapter: 3,
  endVerse: 1,
  label: 'Psalms 3:1',
};

const result = (verse: number, text: string, highlights: { start: number; end: number }[]) => ({
  reference: { bookCode: 'PSA', chapter: 3, verse, label: `Psalms 3:${verse}` },
  text,
  highlights,
});

describe('ReferenceSearch', () => {
  it('opens a resolved reference without searching', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'resolved', reference: REFERENCE });
    const { onOpenReference } = renderSearch();
    submit('Ps 3:1');
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(1, REFERENCE.id));
    const bodies = calls('/bible/resolve').map(
      ([, init]) => JSON.parse(init?.body as string) as unknown,
    );
    expect(bodies).toStrictEqual([{ input: 'Ps 3:1', editionId: EDITION_ID }]);
    expect(calls('/bible/search')).toHaveLength(0);
  });

  it('offers the candidate books for an ambiguous name and resolves the one picked', async () => {
    resolveHandler = (_url, body) =>
      (body as { input: string }).input === 'Jude 1'
        ? jsonResponse(200, { outcome: 'resolved', reference: { ...REFERENCE, bookCode: 'JUD' } })
        : jsonResponse(200, {
            outcome: 'ambiguous',
            candidates: [
              { bookCode: 'JDG', bookName: 'Judges', input: 'Judges 1' },
              { bookCode: 'JUD', bookName: 'Jude', input: 'Jude 1' },
            ],
          });
    const { onOpenReference } = renderSearch();
    submit('Jud 1');
    const group = await screen.findByRole('group', { name: 'Which book did you mean?' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['Judges', 'Jude']);
    fireEvent.click(within(group).getByRole('button', { name: 'Jude' }));
    // The pick is a new lookup, so a new navigation token.
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(2, REFERENCE.id));
  });

  it('shows the reference correction for an invalid reference and runs no keyword search', async () => {
    resolveHandler = () => jsonResponse(422, envelope('REFERENCE_CHAPTER_OUT_OF_RANGE'));
    const { onOpenReference } = renderSearch();
    submit('Gen 99:1');
    // Fixed copy for the code, never the server's message.
    expect(textOf(await screen.findByRole('alert'))).toBe(
      'That chapter does not exist in this book. Check the reference and try again.',
    );
    expect(screen.queryByText(/Server wording/)).toBeNull();
    expect(screen.getByLabelText('Reference or words to search').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(calls('/bible/search')).toHaveLength(0);
    expect(onOpenReference).not.toHaveBeenCalled();
  });

  it('searches keywords the resolver does not read as a reference, highlights matches, and opens a result', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    searchHandler = (url) =>
      url.searchParams.get('cursor') === 'page-2'
        ? jsonResponse(200, {
            results: [result(3, 'Third placeholder.', [{ start: 6, end: 17 }])],
            nextCursor: null,
            referenceSuggestion: null,
          })
        : jsonResponse(200, {
            results: [result(1, 'An ’example’ placeholder.', [{ start: 3, end: 12 }])],
            nextCursor: 'page-2',
            referenceSuggestion: null,
          });
    const { onOpenVerse } = renderSearch();
    submit('placeholder words');

    expect(await screen.findByRole('heading', { name: 'Search results' })).toBeTruthy();
    const [first] = calls('/bible/search');
    const params = new URL(first?.[0] ?? '').searchParams;
    expect(Object.fromEntries(params)).toStrictEqual({
      q: 'placeholder words',
      mode: 'terms',
      editionId: EDITION_ID,
    });
    // Code-point offsets: the curly quotes are single code points.
    const mark = await screen.findByText('’example’');
    expect(mark.tagName).toBe('MARK');
    expect(screen.getByText('Attribution line from the rights record.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    expect(await screen.findByText('placeholder')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Psalms 3:3' }));
    // Opened by its own edition and verse.
    expect(onOpenVerse).toHaveBeenCalledWith({
      editionId: EDITION_ID,
      bookCode: 'PSA',
      chapter: 3,
      verse: 3,
    });
  });

  it('searches a quoted phrase literally, never as a reference, within the chosen book', async () => {
    searchHandler = () =>
      jsonResponse(200, { results: [], nextCursor: null, referenceSuggestion: null });
    renderSearch();
    fireEvent.change(screen.getByLabelText('Search in'), { target: { value: 'PSA' } });
    submit('“Psalm 3 placeholder”');
    expect(await screen.findByText('No verses contain this exact phrase.')).toBeTruthy();
    expect(calls('/bible/resolve')).toHaveLength(0);
    const params = new URL(calls('/bible/search')[0]?.[0] ?? '').searchParams;
    expect(Object.fromEntries(params)).toStrictEqual({
      q: 'Psalm 3 placeholder',
      mode: 'phrase',
      editionId: EDITION_ID,
      book: 'PSA',
    });
  });

  it('searches the exact phrase when the option is checked', async () => {
    searchHandler = () =>
      jsonResponse(200, { results: [], nextCursor: null, referenceSuggestion: null });
    renderSearch();
    fireEvent.click(screen.getByLabelText('Exact phrase'));
    submit('Rom 9:1');
    expect(await screen.findByText('No verses contain this exact phrase.')).toBeTruthy();
    expect(calls('/bible/resolve')).toHaveLength(0);
  });

  it('offers a book-only search as a reference to open', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    searchHandler = () =>
      jsonResponse(200, {
        results: [],
        nextCursor: null,
        referenceSuggestion: { outcome: 'resolved', reference: { ...REFERENCE, label: 'Jude' } },
      });
    const { onOpenReference } = renderSearch();
    submit('placeholder');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Jude' }));
    // Opening the suggestion is a navigation of its own: it takes a new token.
    expect(onOpenReference).toHaveBeenCalledWith(2, REFERENCE.id);
    expect(screen.getByText('No verses contain all of these words.')).toBeTruthy();
  });

  it('asks for input instead of sending an empty query', () => {
    renderSearch();
    submit('   ');
    expect(textOf(screen.getByRole('alert'))).toContain(
      'Enter a reference such as Romans 9:1, or words to search for.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never stores the query in local storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    searchHandler = () =>
      jsonResponse(200, { results: [], nextCursor: null, referenceSuggestion: null });
    renderSearch();
    submit('private words');
    await screen.findByText('No verses contain all of these words.');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('keeps one status region mounted and changes only its text: looking up, searching, results', async () => {
    const lookup = deferred<Response>();
    const page = deferred<Response>();
    resolveHandler = () => lookup.promise;
    searchHandler = () => page.promise;
    renderSearch();
    const status = screen.getByRole('status');
    expect(textOf(status)).toBe('');

    submit('placeholder');
    await waitFor(() => expect(textOf(status)).toBe('Looking up…'));
    lookup.resolve(jsonResponse(200, { outcome: 'not_reference' }));
    await waitFor(() => expect(textOf(status)).toBe('Searching…'));
    page.resolve(
      jsonResponse(200, {
        results: [result(1, 'Placeholder one.', [{ start: 0, end: 11 }])],
        nextCursor: null,
        referenceSuggestion: null,
      }),
    );
    await waitFor(() =>
      expect(textOf(status)).toBe('Showing 1 verse containing all of these words.'),
    );
    expect(screen.getByRole('status')).toBe(status);
  });

  it('says no results in the same status region', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    searchHandler = () =>
      jsonResponse(200, { results: [], nextCursor: null, referenceSuggestion: null });
    renderSearch();
    const status = screen.getByRole('status');
    submit('placeholder');
    await waitFor(() => expect(textOf(status)).toBe('No verses contain all of these words.'));
    expect(screen.getAllByRole('status')).toStrictEqual([status]);
  });

  it('never shows results from one edition under another: switching translation drops them', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    searchHandler = () =>
      jsonResponse(200, {
        results: [result(1, 'Placeholder one.', [{ start: 0, end: 11 }])],
        nextCursor: null,
        referenceSuggestion: null,
      });
    const { switchTo, onOpenVerse } = renderSearch();
    submit('placeholder');
    expect(await screen.findByRole('button', { name: 'Psalms 3:1' })).toBeTruthy();
    expect(screen.getByText('Attribution line from the rights record.')).toBeTruthy();

    switchTo({ ...OTHER_TRANSLATION, attribution: 'Other attribution line.' });
    expect(screen.queryByRole('heading', { name: 'Search results' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Psalms 3:1' })).toBeNull();
    expect(screen.queryByText('Other attribution line.')).toBeNull();
    expect(textOf(screen.getByRole('status'))).toBe('');
    expect(onOpenVerse).not.toHaveBeenCalled();
  });

  it('drops ambiguous candidates from one edition when the translation changes', async () => {
    resolveHandler = () =>
      jsonResponse(200, {
        outcome: 'ambiguous',
        candidates: [
          { bookCode: 'JDG', bookName: 'Judges', input: 'Judges 1' },
          { bookCode: 'JUD', bookName: 'Jude', input: 'Jude 1' },
        ],
      });
    const { switchTo } = renderSearch();
    submit('Jud 1');
    await screen.findByRole('group', { name: 'Which book did you mean?' });
    switchTo(OTHER_TRANSLATION);
    expect(screen.queryByRole('group', { name: 'Which book did you mean?' })).toBeNull();
  });

  it('applies only the latest lookup when two overlap and answer out of order', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const pending = [first, second];
    resolveHandler = () => {
      const next = pending.shift();
      if (!next) throw new Error('unexpected resolve');
      return next.promise;
    };
    const { onOpenReference } = renderSearch();
    submit('placeholder words');
    submit('Ps 3:1');
    second.resolve(jsonResponse(200, { outcome: 'resolved', reference: REFERENCE }));
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(2, REFERENCE.id));
    first.resolve(jsonResponse(200, { outcome: 'not_reference' }));
    await new Promise((r) => setTimeout(r, 20));
    // The older lookup neither searched nor opened anything.
    expect(calls('/bible/search')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Search results' })).toBeNull();
    expect(onOpenReference).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for a rate-limited search, in fixed copy', async () => {
    resolveHandler = () => jsonResponse(200, { outcome: 'not_reference' });
    let first = true;
    searchHandler = () => {
      if (!first) {
        return jsonResponse(200, { results: [], nextCursor: null, referenceSuggestion: null });
      }
      first = false;
      return jsonResponse(429, envelope('RATE_LIMITED', { retryable: true }));
    };
    renderSearch();
    submit('placeholder');
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('Too many requests right now.Retry');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No verses contain all of these words.')).toBeTruthy();
  });

  it('offers Retry when the lookup is unavailable (503), and never shows the server message', async () => {
    let first = true;
    resolveHandler = () => {
      if (!first) return jsonResponse(200, { outcome: 'resolved', reference: REFERENCE });
      first = false;
      return jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', { retryable: true }));
    };
    const { onOpenReference } = renderSearch();
    submit('Ps 3:1');
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe("We couldn't look that up.Retry");
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(2, REFERENCE.id));
    const bodies = calls('/bible/resolve').map(
      ([, init]) => JSON.parse(init?.body as string) as unknown,
    );
    expect(bodies).toStrictEqual([
      { input: 'Ps 3:1', editionId: EDITION_ID },
      { input: 'Ps 3:1', editionId: EDITION_ID },
    ]);
  });
});
