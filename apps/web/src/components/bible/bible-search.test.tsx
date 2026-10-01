import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITION_ID, TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { ReferenceSearch } from './bible-search';

type Handler = (url: URL, body: unknown) => Response;
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
  const onOpenReference = vi.fn();
  const onOpenVerse = vi.fn();
  renderWithQuery(
    <ReferenceSearch
      translation={TRANSLATION}
      onOpenReference={onOpenReference}
      onOpenVerse={onOpenVerse}
    />,
  );
  return { onOpenReference, onOpenVerse };
}

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
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(REFERENCE.id));
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
    await vi.waitFor(() => expect(onOpenReference).toHaveBeenCalledWith(REFERENCE.id));
  });

  it('shows the reference correction for an invalid reference and runs no keyword search', async () => {
    resolveHandler = () =>
      jsonResponse(422, {
        code: 'REFERENCE_CHAPTER_OUT_OF_RANGE',
        message: 'That chapter does not exist in this book',
        retryable: false,
        correlationId: 'c',
      });
    const { onOpenReference } = renderSearch();
    submit('Gen 99:1');
    expect(textOf(await screen.findByRole('alert'))).toContain(
      'That chapter does not exist in this book. Check the reference and try again.',
    );
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
    expect(onOpenVerse).toHaveBeenCalledWith('PSA', 3, 3);
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
    expect(onOpenReference).toHaveBeenCalledWith(REFERENCE.id);
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
});
