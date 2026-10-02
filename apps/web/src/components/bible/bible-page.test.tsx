import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chapter,
  deferred,
  EDITION_ID,
  OTHER_EDITION_ID,
  OTHER_PSALM_3,
  OTHER_PSALM_3_ID,
  OTHER_TRANSLATION,
  PSALM_3,
  PSALM_3_ID,
  PSALM_4,
  PSALM_4_ID,
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
const GENESIS_1_ID = '77777777-2222-4333-8444-555555555555';
const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const STUDY = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 3,
  contentRevision: 2,
  startingReference: null,
  mainQuestion: null,
  originalQuestion: null,
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};
const REVELATION_22_ID = '88888888-2222-4333-8444-555555555555';
const VERSE_ID = '99999999-2222-4333-8444-555555555555';

const GENESIS_1 = chapter({
  book: { code: 'GEN', name: 'Genesis', chapterCount: 50 },
  chapter: 1,
  reference: { ...wholeChapterReference('GEN', 1, 'Genesis'), id: GENESIS_1_ID },
});
const REVELATION_22 = chapter({
  book: { code: 'REV', name: 'Revelation', chapterCount: 22 },
  chapter: 22,
  reference: { ...wholeChapterReference('REV', 22, 'Revelation'), id: REVELATION_22_ID },
});

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

type Respond = () => Response | Promise<Response>;
let translationsList: (typeof TRANSLATION)[];
let meResponses: Respond[];
let passages: Map<string, Respond>;
let resolveResponses: Respond[];
let referenceResponses: Respond[];
let fetchMock: ReturnType<typeof vi.fn>;

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'Server wording that must never be shown',
  retryable: false,
  correlationId: 'c',
  ...extra,
});

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  search = '';
  translationsList = [TRANSLATION, OTHER_TRANSLATION];
  meResponses = [];
  resolveResponses = [];
  referenceResponses = [];
  passages = new Map<string, Respond>([
    [PSALM_3_ID, () => jsonResponse(200, PSALM_3)],
    [PSALM_4_ID, () => jsonResponse(200, PSALM_4)],
    [OTHER_PSALM_3_ID, () => jsonResponse(200, OTHER_PSALM_3)],
    [GENESIS_1_ID, () => jsonResponse(200, GENESIS_1)],
    [REVELATION_22_ID, () => jsonResponse(200, REVELATION_22)],
  ]);
  fetchMock = vi.fn((input: string) => {
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith('/me')) {
      return Promise.resolve((meResponses.shift() ?? (() => jsonResponse(200, ME)))());
    }
    if (path.endsWith('/bible/translations')) {
      return Promise.resolve(jsonResponse(200, { translations: translationsList }));
    }
    if (path.endsWith('/bible/passages')) {
      const respond = passages.get(url.searchParams.get('referenceId') ?? '');
      if (!respond) throw new Error('unexpected passage');
      return Promise.resolve(respond());
    }
    if (path.endsWith('/bible/search')) return Promise.resolve(jsonResponse(200, SEARCH_PAGE));
    // BIB-24: reading in a study.
    if (path.endsWith(`/studies/${STUDY_ID}`)) return Promise.resolve(jsonResponse(200, STUDY));
    if (path.endsWith(`/studies/${STUDY_ID}/annotations`)) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    const queue = path.endsWith('/bible/resolve')
      ? resolveResponses
      : path.endsWith('/bible/references')
        ? referenceResponses
        : null;
    const next = queue?.shift();
    if (!next) throw new Error(`unexpected fetch ${input}`);
    return Promise.resolve(next());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const referenceBody = (id: string, editionId = EDITION_ID) => ({
  reference: { ...wholeChapterReference('PSA', 4, 'Psalms'), id, editionId },
});
const referenceOk =
  (id: string, editionId = EDITION_ID) =>
  () =>
    jsonResponse(200, referenceBody(id, editionId));

const bodiesTo = (path: string) =>
  (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([input]) => new URL(input).pathname.endsWith(path))
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
const requestsTo = (path: string) =>
  (fetchMock.mock.calls as [string][]).filter(([input]) => new URL(input).pathname.endsWith(path));

/** Every URL the page navigated to holds the opaque reference id only. */
function expectOpaqueUrls() {
  expect(push).toHaveBeenCalled();
  for (const [href] of push.mock.calls as [string][]) {
    expect(href).toMatch(/^\/bible(\?ref=[0-9a-f-]{36})?$/);
  }
}

async function renderAt(query: string) {
  search = query;
  const view = renderWithQuery(<BiblePage />);
  await screen.findByRole('heading', { level: 1, name: 'Bible' });
  /** What the router does on push: the URL changes and the page renders with it. */
  const follow = (href: string) => {
    search = new URL(href, 'http://localhost').search.slice(1);
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BiblePage />
      </QueryClientProvider>,
    );
  };
  return { ...view, follow };
}

const pickerForm = () => screen.getByRole('form', { name: 'Choose a chapter' });
function openFromPicker(book: string, chapterNumber: string) {
  fireEvent.change(within(pickerForm()).getByLabelText('Book'), { target: { value: book } });
  fireEvent.change(within(pickerForm()).getByLabelText('Chapter'), {
    target: { value: chapterNumber },
  });
  fireEvent.click(within(pickerForm()).getByRole('button', { name: 'Open' }));
}

describe('BiblePage', () => {
  it('reads the reference from the URL and moves to the next chapter in one step, by its id', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
    const [passageUrl] = requestsTo('/bible/passages');
    expect(Object.fromEntries(new URL(passageUrl?.[0] ?? '').searchParams)).toStrictEqual({
      referenceId: PSALM_3_ID,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));
    expect(push).toHaveBeenCalledWith(`/bible?ref=${PSALM_4_ID}`, { scroll: false });
    // No resolve and no reference lookup: the link carried the id.
    expect(requestsTo('/bible/resolve')).toHaveLength(0);
    expect(requestsTo('/bible/references')).toHaveLength(0);
    expectOpaqueUrls();
  });

  it('keeps a bookmark in its own edition, whichever editions are active and in whatever order', async () => {
    for (const order of [
      [OTHER_TRANSLATION, TRANSLATION],
      [TRANSLATION, OTHER_TRANSLATION],
      [TRANSLATION],
    ]) {
      translationsList = order;
      const view = await renderAt(`ref=${PSALM_3_ID}`);
      await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
      expect(screen.getByLabelText<HTMLSelectElement>('Translation').value).toBe(EDITION_ID);
      expect(screen.getByText('Attribution line from the rights record.')).toBeTruthy();
      // A lookup from here is in the bookmark's edition too.
      resolveResponses.push(() => jsonResponse(200, { outcome: 'not_reference' }));
      fireEvent.change(screen.getByLabelText('Reference or words to search'), {
        target: { value: 'placeholder' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      await screen.findByRole('heading', { name: 'Search results' });
      expect(bodiesTo('/bible/resolve').at(-1)).toStrictEqual({
        input: 'placeholder',
        editionId: EDITION_ID,
      });
      view.unmount();
    }
  });

  it('opens a bookmark of the other edition in that edition', async () => {
    await renderAt(`ref=${OTHER_PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    expect(screen.getByText('Other attribution line.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Translation').value).toBe(OTHER_EDITION_ID),
    );
  });

  it('opens a picked book and chapter by structure, never by typed text', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    referenceResponses.push(referenceOk(GENESIS_1_ID));
    openFromPicker('JUD', '1');
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${GENESIS_1_ID}`, { scroll: false }),
    );
    expect(bodiesTo('/bible/references')).toStrictEqual([
      { editionId: EDITION_ID, bookCode: 'JUD', chapter: 1 },
    ]);
    expect(requestsTo('/bible/resolve')).toHaveLength(0);
  });

  it('shows the last-initiated chapter, focused, when two openings overlap and answer out of order', async () => {
    const view = await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    const genesis = deferred<Response>();
    const revelation = deferred<Response>();
    referenceResponses.push(
      () => genesis.promise,
      () => revelation.promise,
    );
    openFromPicker('GEN', '1');
    openFromPicker('REV', '22');

    // The later request answers first and wins.
    revelation.resolve(jsonResponse(200, referenceBody(REVELATION_22_ID)));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${REVELATION_22_ID}`, { scroll: false }),
    );
    view.follow(`/bible?ref=${REVELATION_22_ID}`);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Revelation 22' });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    // The earlier one answers late and is ignored: no navigation, nothing reported.
    genesis.resolve(jsonResponse(200, referenceBody(GENESIS_1_ID)));
    await new Promise((r) => setTimeout(r, 20));
    expect(push).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Revelation 22' })).toBe(heading);
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets a later Next win over an earlier picker opening that answers afterwards', async () => {
    const view = await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    const genesis = deferred<Response>();
    referenceResponses.push(() => genesis.promise);
    openFromPicker('GEN', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));
    view.follow(`/bible?ref=${PSALM_4_ID}`);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Psalms 4' });

    genesis.resolve(jsonResponse(200, referenceBody(GENESIS_1_ID)));
    await new Promise((r) => setTimeout(r, 20));
    expect(push.mock.calls).toStrictEqual([[`/bible?ref=${PSALM_4_ID}`, { scroll: false }]]);
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('lets browser Back win over a lookup that answers afterwards', async () => {
    const view = await renderAt(`ref=${PSALM_4_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 4' });
    const genesis = deferred<Response>();
    referenceResponses.push(() => genesis.promise);
    openFromPicker('GEN', '1');
    // Back: the URL changes without the page pushing it.
    view.follow(`/bible?ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });

    genesis.resolve(jsonResponse(200, referenceBody(GENESIS_1_ID)));
    await new Promise((r) => setTimeout(r, 20));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
  });

  it('keeps one status region mounted and says when a passage is being opened', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    const page = within(screen.getByRole('main'));
    const [status] = page.getAllByRole('status');
    if (!status) throw new Error('no status region');
    expect(textOf(status)).toBe('');
    const slow = deferred<Response>();
    referenceResponses.push(() => slow.promise);
    openFromPicker('GEN', '1');
    await waitFor(() => expect(textOf(status)).toBe('Opening the passage…'));
    slow.resolve(jsonResponse(200, referenceBody(GENESIS_1_ID)));
    await waitFor(() => expect(textOf(status)).toBe(''));
    expect(page.getAllByRole('status')[0]).toBe(status);
  });

  it('keeps the chapter on screen and offers Retry when opening one is unavailable (503)', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    referenceResponses.push(
      () => jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', { retryable: true })),
      referenceOk(GENESIS_1_ID),
    );
    openFromPicker('GEN', '1');

    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe("We couldn't open that passage.Retry");
    expect(screen.getByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${GENESIS_1_ID}`, { scroll: false }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a chosen chapter does not exist in fixed copy, with no Retry', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    referenceResponses.push(() => jsonResponse(422, envelope('REFERENCE_CHAPTER_OUT_OF_RANGE')));
    openFromPicker('GEN', '1');
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('That chapter does not exist in this book.');
    expect(push).not.toHaveBeenCalled();
  });

  it('sends the user to sign in, coming back here, when the session has ended (401)', async () => {
    passages.set(PSALM_3_ID, () =>
      jsonResponse(401, { ...envelope('UNAUTHENTICATED'), message: 'Sign in to continue' }),
    );
    meResponses.push(
      () => jsonResponse(200, ME),
      () => jsonResponse(401, { ...envelope('UNAUTHENTICATED'), message: 'Sign in to continue' }),
    );
    await renderAt(`ref=${PSALM_3_ID}`);
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    const [[href]] = replace.mock.calls as [[string]];
    expect(href).toMatch(/^\/sign-in\?next=/);
    expect(push).not.toHaveBeenCalled();
  });

  it('puts a typed reference in the URL by its opaque id, never the typed text', async () => {
    await renderAt('');
    resolveResponses.push(() =>
      jsonResponse(200, { outcome: 'resolved', reference: referenceBody(PSALM_4_ID).reference }),
    );
    fireEvent.change(await screen.findByLabelText('Reference or words to search'), {
      target: { value: 'Ps 4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${PSALM_4_ID}`, { scroll: false }),
    );
    expectOpaqueUrls();
  });

  it('reopens the same chapter in another translation on Apply, by structure', async () => {
    await renderAt(`ref=${PSALM_3_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Psalms 3' });
    referenceResponses.push(referenceOk(OTHER_PSALM_3_ID, OTHER_EDITION_ID));
    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    expect(requestsTo('/bible/references')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${OTHER_PSALM_3_ID}`, { scroll: false }),
    );
    expect(bodiesTo('/bible/references')).toStrictEqual([
      { editionId: OTHER_EDITION_ID, bookCode: 'PSA', chapter: 3 },
    ]);
    expectOpaqueUrls();
  });

  it('opens a search result by its own edition and verse', async () => {
    await renderAt('');
    resolveResponses.push(() => jsonResponse(200, { outcome: 'not_reference' }));
    referenceResponses.push(referenceOk(VERSE_ID));
    fireEvent.change(await screen.findByLabelText('Reference or words to search'), {
      target: { value: 'placeholder' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Psalms 3:2' }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/bible?ref=${VERSE_ID}`, { scroll: false }),
    );
    expect(bodiesTo('/bible/references')).toStrictEqual([
      { editionId: EDITION_ID, bookCode: 'PSA', chapter: 3, verse: 2 },
    ]);
    expectOpaqueUrls();
  });

  it('drops search results when the translation changes with nothing open', async () => {
    await renderAt('');
    resolveResponses.push(() => jsonResponse(200, { outcome: 'not_reference' }));
    fireEvent.change(await screen.findByLabelText('Reference or words to search'), {
      target: { value: 'placeholder' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByRole('button', { name: 'Psalms 3:2' });

    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Search results' })).toBeNull(),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Translation').value).toBe(OTHER_EDITION_ID);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('BiblePage in a study (BIB-24)', () => {
  it('names the study, shows its highlights section, and keeps reading in it across chapters with opaque ids only', async () => {
    const { follow } = await renderAt(`ref=${PSALM_3_ID}&study=${STUDY_ID}`);
    const link = await screen.findByRole('link', { name: 'Conscience' });
    expect(link.getAttribute('href')).toBe(`/studies/${STUDY_ID}`);
    expect(await screen.findByRole('region', { name: 'Highlights in this chapter' })).toBeTruthy();
    // Highlights are asked for by the passage's opaque reference id.
    expect(
      requestsTo('/annotations').map(([input]) => new URL(input).searchParams.toString()),
    ).toStrictEqual([`referenceId=${PSALM_3_ID}`]);

    fireEvent.click(await screen.findByRole('button', { name: 'Next chapter: Psalms 4' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const [href] = push.mock.calls.at(-1) as [string];
    expect(href).toBe(`/bible?ref=${PSALM_4_ID}&study=${STUDY_ID}`);
    follow(href);
    expect(await screen.findByRole('heading', { name: 'Psalms 4' })).toBeTruthy();
  });
});
