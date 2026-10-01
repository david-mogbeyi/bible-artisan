import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITION_ID } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { StudyLibraryPage } from './study-library';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const ROMANS = {
  id: 'bbbbbbbb-2222-4333-8444-555555555555',
  editionId: EDITION_ID,
  bookCode: 'ROM',
  startChapter: 9,
  startVerse: 1,
  endChapter: 9,
  endVerse: 1,
  label: 'Romans 9:1',
};
const WITNESS = { id: 'cccccccc-2222-4333-8444-555555555555', name: 'Witness' };

function study(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `aaaaaaaa-2222-4333-8444-${String(n).padStart(12, '0')}`,
    title: `Study ${n}`,
    pinned: false,
    lifecycle: 'active',
    startingReference: null,
    tags: [],
    lastActivityAt: '2026-10-01T12:00:00.000Z',
    createdAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

const PINNED = study(1, {
  title: 'Conscience in Romans',
  pinned: true,
  startingReference: ROMANS,
  tags: [WITNESS],
});
const OTHER = study(2, { title: 'Grace alone' });

const envelope = (code: string, retryable = false) => ({
  code,
  message: 'server text, never shown',
  retryable,
  correlationId: 'x',
});

type Reply = Response | Error;
/** Library replies, in order; each request's params are recorded. */
let replies: Reply[];
let requests: URLSearchParams[];

beforeEach(() => {
  replies = [];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://api.test');
      if (url.pathname.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
      if (url.pathname.endsWith('/studies')) {
        requests.push(url.searchParams);
        const next = replies.shift();
        if (!next) throw new Error(`unexpected library request ${url.search}`);
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      throw new Error(`unexpected fetch ${input}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const pageOf = (items: unknown[], nextCursor: string | null = null) =>
  jsonResponse(200, { items, nextCursor });

async function renderLibrary(first: Reply = pageOf([PINNED, OTHER])) {
  replies.push(first);
  const rendered = renderWithQuery(<StudyLibraryPage />);
  await screen.findByRole('heading', { name: 'Your studies' });
  return rendered;
}

const params = (n: number) => Object.fromEntries(requests[n] ?? []);

describe('Study library', () => {
  it('lists pinned studies in their own group first, each card linking to its study', async () => {
    await renderLibrary();
    const pinned = await screen.findByRole('region', { name: 'Pinned' });
    const others = screen.getByRole('region', { name: 'Other studies' });
    expect(params(0)).toStrictEqual({ sort: 'recent' });

    const link = within(pinned).getByRole('link', { name: 'Conscience in Romans' });
    expect(link.getAttribute('href')).toBe(`/studies/${PINNED.id}`);
    expect(within(pinned).getByText(/Pinned · Romans 9:1 · Last activity/)).toBeTruthy();
    expect(within(pinned).getByRole('button', { name: 'Filter by tag Witness' })).toBeTruthy();
    expect(within(others).getByRole('link', { name: 'Grace alone' })).toBeTruthy();
    // Pinned group comes before the rest in document order.
    expect(pinned.compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('searches through the API only: the text never reaches the page URL or localStorage', async () => {
    const before = window.location.href;
    await renderLibrary();
    await screen.findByRole('link', { name: 'Grace alone' });
    replies.push(pageOf([OTHER]));
    fireEvent.change(screen.getByLabelText('Search titles, descriptions and tags'), {
      target: { value: '  grace  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Conscience in Romans' })).toBeNull(),
    );
    expect(params(1)).toStrictEqual({ sort: 'recent', q: 'grace' });
    expect(window.location.href).toBe(before);
    expect(JSON.stringify({ ...localStorage })).not.toContain('grace');
  });

  it('says when nothing matches, and Clear filters (or an empty search) resets them', async () => {
    await renderLibrary();
    await screen.findByRole('link', { name: 'Grace alone' });
    replies.push(pageOf([]));
    fireEvent.change(screen.getByLabelText('Search titles, descriptions and tags'), {
      target: { value: 'nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No studies match.')).toBeTruthy();
    expect(screen.queryByText('No studies yet.')).toBeNull();

    replies.push(pageOf([PINNED, OTHER]));
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await screen.findByRole('link', { name: 'Grace alone' });
    expect(params(2)).toStrictEqual({ sort: 'recent' });
    expect(
      screen.getByLabelText<HTMLInputElement>('Search titles, descriptions and tags').value,
    ).toBe('');

    // Submitting an empty box after a search also resets.
    replies.push(pageOf([OTHER]));
    fireEvent.change(screen.getByLabelText('Search titles, descriptions and tags'), {
      target: { value: 'grace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(requests).toHaveLength(4));
    fireEvent.change(screen.getByLabelText('Search titles, descriptions and tags'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    // The unfiltered list is cached, so no new request is needed to show it.
    await screen.findByRole('link', { name: 'Conscience in Romans' });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('distinguishes an empty library, and offers a new study', async () => {
    await renderLibrary(pageOf([]));
    expect(await screen.findByText('No studies yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start a new study' }).getAttribute('href')).toBe(
      '/studies/new',
    );
    expect(screen.queryByText('No studies match.')).toBeNull();
  });

  it('filters by a tag chip, shows the filter, and clears it', async () => {
    await renderLibrary();
    replies.push(pageOf([PINNED]));
    fireEvent.click(await screen.findByRole('button', { name: 'Filter by tag Witness' }));
    expect(await screen.findByText('Tag: Witness')).toBeTruthy();
    await waitFor(() => expect(params(1)).toStrictEqual({ sort: 'recent', tag: WITNESS.id }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Grace alone' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Clear tag filter' }));
    await screen.findByRole('link', { name: 'Grace alone' });
    expect(screen.queryByText('Tag: Witness')).toBeNull();
  });

  it('changes the sort through a labelled select', async () => {
    await renderLibrary();
    await screen.findByRole('link', { name: 'Grace alone' });
    replies.push(pageOf([OTHER, PINNED]));
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title' } });
    await waitFor(() => expect(params(1)).toStrictEqual({ sort: 'title' }));
  });

  it('refuses an over-wordy search inline without asking the API', async () => {
    await renderLibrary();
    await screen.findByRole('link', { name: 'Grace alone' });
    const box = screen.getByLabelText('Search titles, descriptions and tags');
    fireEvent.change(box, { target: { value: 'a b c d e f g h i j k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Search for at most 10 words')).toBeTruthy();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(requests).toHaveLength(1);
  });

  it('loads more on request, appends the page and announces it', async () => {
    await renderLibrary(pageOf([PINNED, OTHER], 'cursor-1'));
    replies.push(pageOf([study(3), study(4)]));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Study 4' });
    expect(params(1)).toStrictEqual({ sort: 'recent', cursor: 'cursor-1' });
    expect(screen.getByRole('link', { name: 'Grace alone' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('2 more studies loaded.');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // The button is gone, so focus moves to the first study the last page added.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Study 3' })),
    );
  });

  it('keeps loaded studies when Load more fails, and retries', async () => {
    await renderLibrary(pageOf([PINNED, OTHER], 'cursor-1'));
    replies.push(jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', true)));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load more studies.");
    expect(screen.getByRole('link', { name: 'Grace alone' })).toBeTruthy();

    replies.push(pageOf([study(3)]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link', { name: 'Study 3' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts over when the server refuses a cursor', async () => {
    await renderLibrary(pageOf([PINNED, OTHER], 'stale'));
    replies.push(jsonResponse(400, { ...envelope('VALIDATION'), fieldErrors: { cursor: ['x'] } }));
    replies.push(pageOf([OTHER]));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Conscience in Romans' })).toBeNull(),
    );
    expect(params(2)).toStrictEqual({ sort: 'recent' });
    expect(screen.getByRole('status').textContent).toBe(
      'Your studies changed. Showing the list from the start.',
    );
  });

  it('explains a failed first load and retries', async () => {
    await renderLibrary(jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', true)));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load your studies.");
    expect(alert.textContent).not.toContain('server text');
    replies.push(pageOf([OTHER]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link', { name: 'Grace alone' });
  });

  it('keeps the results it has when a refresh fails, with when they were loaded', async () => {
    const { queryClient } = await renderLibrary();
    await screen.findByRole('link', { name: 'Grace alone' });
    replies.push(new TypeError('offline'));
    await queryClient.refetchQueries({ queryKey: ['studies'] });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^Couldn.t refresh\. Showing results from .+\.Retry$/);
    expect(screen.getByRole('link', { name: 'Grace alone' })).toBeTruthy();

    replies.push(pageOf([PINNED, OTHER, study(5)]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link', { name: 'Study 5' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
