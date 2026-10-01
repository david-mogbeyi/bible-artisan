import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDITION_ID,
  OTHER_EDITION_ID,
  OTHER_TRANSLATION,
  PSALM_3,
  TRANSLATION,
  wholeChapterReference,
} from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { BiblePage } from './bible-page';

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const SHOWN_ID = '33333333-2222-4333-8444-555555555555';
const RESOLVED_ID = '55555555-2222-4333-8444-555555555555';

const SEARCH_PAGE = {
  results: [
    {
      reference: { bookCode: 'PSA', chapter: 3, verse: 2, label: 'Psalms 3:2' },
      text: 'Placeholder text two.',
      highlights: [{ start: 0, end: 11 }],
    },
  ],
  nextCursor: null,
  referenceSuggestion: null,
};

let resolveResponses: Array<() => Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockReset();
  search = '';
  resolveResponses = [];
  fetchMock = vi.fn((input: string) => {
    const path = new URL(input).pathname;
    if (path.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
    if (path.endsWith('/bible/translations')) {
      return Promise.resolve(jsonResponse(200, { translations: [TRANSLATION, OTHER_TRANSLATION] }));
    }
    if (path.endsWith('/bible/passages')) return Promise.resolve(jsonResponse(200, PSALM_3));
    if (path.endsWith('/bible/search')) return Promise.resolve(jsonResponse(200, SEARCH_PAGE));
    if (path.endsWith('/bible/resolve')) {
      const next = resolveResponses.shift();
      if (!next) throw new Error('unexpected resolve');
      return Promise.resolve(next());
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const resolved = () =>
  jsonResponse(200, {
    outcome: 'resolved',
    reference: { ...wholeChapterReference('PSA', 4, 'Psalms'), id: RESOLVED_ID },
  });

const resolveBodies = () =>
  (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([input]) => new URL(input).pathname.endsWith('/bible/resolve'))
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);

/** Every URL the page navigated to holds opaque ids only, never a reference or search text. */
function expectOpaqueUrls() {
  const uuid = '[0-9a-f-]{36}';
  expect(push).toHaveBeenCalled();
  for (const [href] of push.mock.calls as [string][]) {
    expect(href).toMatch(new RegExp(`^/bible(\\?(edition=${uuid}&?)?(ref=${uuid})?)?$`));
  }
}

async function renderAt(query: string) {
  search = query;
  const view = renderWithQuery(<BiblePage />);
  await screen.findByRole('heading', { level: 1, name: 'Bible' });
  return view;
}

describe('BiblePage', () => {
  it('reads the reference from the URL and moves to the next chapter by resolving it', async () => {
    await renderAt(`ref=${SHOWN_ID}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
    const passageUrl = new URL(
      (fetchMock.mock.calls as [string][])
        .map(([input]) => input)
        .find((input) => input.includes('/bible/passages')) ?? '',
    );
    expect(Object.fromEntries(passageUrl.searchParams)).toStrictEqual({
      editionId: EDITION_ID,
      referenceId: SHOWN_ID,
    });

    resolveResponses.push(resolved);
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${RESOLVED_ID}`, { scroll: false }),
    );
    expect(resolveBodies()).toStrictEqual([{ input: 'Psalms 4', editionId: EDITION_ID }]);
    expectOpaqueUrls();
  });

  it('opens a single-chapter book by its name, so its number is never read as a verse', async () => {
    await renderAt(`ref=${SHOWN_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    resolveResponses.push(resolved);
    const picker = screen.getByRole('form', { name: 'Choose a chapter' });
    fireEvent.change(within(picker).getByLabelText('Book'), { target: { value: 'JUD' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    expect(resolveBodies()).toStrictEqual([{ input: 'Jude', editionId: EDITION_ID }]);
  });

  it('keeps the chapter on screen and offers Retry when opening the next one fails', async () => {
    await renderAt(`ref=${SHOWN_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    resolveResponses.push(() => jsonResponse(503, { code: 'DEPENDENCY_UNAVAILABLE' }), resolved);
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));

    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain("We couldn't open that passage.");
    expect(screen.getByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${RESOLVED_ID}`, { scroll: false }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts a typed reference in the URL by its opaque id, never the typed text', async () => {
    await renderAt('');
    resolveResponses.push(resolved);
    fireEvent.change(await screen.findByLabelText('Reference or words to search'), {
      target: { value: 'Ps 4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${RESOLVED_ID}`, { scroll: false }),
    );
    expectOpaqueUrls();
  });

  it('reopens the same chapter in another translation and keeps that edition in the URL', async () => {
    await renderAt(`ref=${SHOWN_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    resolveResponses.push(resolved);
    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?edition=${OTHER_EDITION_ID}&ref=${RESOLVED_ID}`, {
        scroll: false,
      }),
    );
    expect(resolveBodies()).toStrictEqual([{ input: 'Psalms 3', editionId: OTHER_EDITION_ID }]);
  });

  it('opens a search result by resolving its verse', async () => {
    await renderAt('');
    resolveResponses.push(() => jsonResponse(200, { outcome: 'not_reference' }), resolved);
    fireEvent.change(await screen.findByLabelText('Reference or words to search'), {
      target: { value: 'placeholder' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Psalms 3:2' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${RESOLVED_ID}`, { scroll: false }),
    );
    expect(resolveBodies()).toStrictEqual([
      { input: 'placeholder', editionId: EDITION_ID },
      { input: 'Psalms 3:2', editionId: EDITION_ID },
    ]);
    expectOpaqueUrls();
  });

  it('says so when the URL names a translation that is not available', async () => {
    await renderAt(`edition=99999999-2222-4333-8444-555555555555&ref=${SHOWN_ID}`);
    expect(
      await screen.findByText(
        'That translation is not available. Showing World English Bible instead.',
      ),
    ).toBeTruthy();
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
  });
});
