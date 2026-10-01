import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chapter,
  EDITION_ID,
  OTHER_EDITION_ID,
  OTHER_TRANSLATION,
  PSALM_3,
  PSALM_4,
  TRANSLATION,
  wholeChapterReference,
} from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { BibleReader, type FocusRequest } from './bible-reader';

const PSALM_3_ID = '33333333-2222-4333-8444-555555555555';
const PSALM_4_ID = '44444444-2222-4333-8444-555555555555';

let responses: Map<string, Array<() => Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

/** Queue responses per reference id; a request with nothing queued fails the test. */
function respond(referenceId: string, ...make: Array<() => Response>) {
  responses.set(referenceId, [...(responses.get(referenceId) ?? []), ...make]);
}

beforeEach(() => {
  responses = new Map();
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (init?.method && init.method !== 'GET') throw new Error('the reader must not write');
    if (!url.pathname.endsWith('/bible/passages')) throw new Error(`unexpected fetch ${input}`);
    // Only opaque ids travel in the URL.
    expect([...url.searchParams.keys()].sort()).toStrictEqual(['editionId', 'referenceId']);
    const id = url.searchParams.get('referenceId') ?? '';
    const next = responses.get(id)?.shift();
    if (!next) throw new Error(`no response queued for ${id}`);
    return Promise.resolve(next());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderReader(referenceId: string | null, focusRequest: FocusRequest | null = null) {
  const onOpenChapter = vi.fn();
  const onChangeEdition = vi.fn();
  const props = {
    translations: [TRANSLATION, OTHER_TRANSLATION],
    editionId: EDITION_ID,
    onOpenChapter,
    onChangeEdition,
  };
  const view = renderWithQuery(
    <BibleReader {...props} referenceId={referenceId} focusRequest={focusRequest} />,
  );
  const rerender = (next: string | null, focus: FocusRequest | null = focusRequest) =>
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BibleReader {...props} referenceId={next} focusRequest={focus} />
      </QueryClientProvider>,
    );
  return { ...view, onOpenChapter, onChangeEdition, rerender };
}

const verseItems = () => within(screen.getByRole('list')).getAllByRole('listitem');

describe('BibleReader', () => {
  it('asks for a reference when nothing is open', () => {
    renderReader(null);
    expect(
      screen.getByText(
        'Enter a reference such as Romans 9:1, or choose a book and chapter, to start reading.',
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a chapter with real verse numbers, its superscription apart from the verse, and the attribution', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    renderReader(PSALM_3_ID);

    expect(await screen.findByRole('heading', { level: 2, name: 'Psalms 3' })).toBeTruthy();
    const items = verseItems();
    expect(items).toHaveLength(3);
    expect(textOf(items[0])).toBe(
      'Heading: Placeholder superscription.Verse 1Placeholder text one.',
    );
    expect(textOf(items[1])).toBe('Verse 2Placeholder text two.');
    // A whole-chapter reference marks nothing.
    expect(screen.queryByText(/Marked verse/)).toBeNull();
    expect(screen.getByText('Attribution line from the rights record.')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'About this translation (opens in a new tab)' })
        .getAttribute('href'),
    ).toBe('https://example.test/about');
  });

  it('shows a verse the edition has no text for, with its number and a plain note', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(
        200,
        chapter({
          book: { code: 'ACT', name: 'Acts', chapterCount: 28 },
          chapter: 8,
          verses: [
            { verse: 1, text: 'Placeholder text one.' },
            { verse: 2, text: '' },
            { verse: 3, text: 'Placeholder text three.' },
          ],
        }),
      ),
    );
    renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Acts 8' });
    expect(verseItems()).toHaveLength(3);
    expect(textOf(verseItems()[1])).toBe('Verse 2No text for this verse in this edition.');
  });

  it('marks the reference range with a bar and text, not color alone', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(200, {
        ...PSALM_3,
        reference: {
          ...wholeChapterReference('PSA', 3, 'Psalms'),
          startVerse: 2,
          label: 'Psalms 3:2–3',
        },
      }),
    );
    renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    expect(textOf(screen.getByText('Psalms 3:2–3').parentElement)).toBe(
      'Psalms 3:2–3 is marked with a bar beside the verse.',
    );
    const [one, two, three] = verseItems();
    expect(textOf(one)).toContain('Verse 1');
    expect(textOf(one)).not.toContain('Marked');
    expect(textOf(two)).toContain('Marked verse 2');
    expect(textOf(three)).toContain('Marked verse 3');
  });

  it('keeps the previous chapter on screen when the next fails, and Retry loads it', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    respond(
      PSALM_4_ID,
      () => jsonResponse(503, { code: 'DEPENDENCY_UNAVAILABLE' }),
      () => jsonResponse(503, { code: 'DEPENDENCY_UNAVAILABLE' }),
      () => jsonResponse(200, PSALM_4),
    );
    const { onOpenChapter, rerender } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));
    expect(onOpenChapter).toHaveBeenCalledWith(
      { editionId: EDITION_ID, bookCode: 'PSA', chapter: 4 },
      true,
    );
    // The host asks for focus on Psalm 4 before its URL (and so this reader) has moved: the old
    // heading must not take it.
    const focus = { referenceId: PSALM_4_ID, n: 1 };
    rerender(PSALM_3_ID, focus);
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Psalms 3' }));
    rerender(PSALM_4_ID, focus);

    // The reader retries a server error once (after ~1 s) before reporting it.
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(textOf(alert)).toContain("We couldn't load this chapter.");
    // FR-BIBLE-009: the last chapter stays visible with Retry.
    expect(screen.getByRole('heading', { name: 'Psalms 3' })).toBeTruthy();
    expect(screen.getByText('Placeholder text one.')).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const heading = await screen.findByRole('heading', { name: 'Psalms 4' });
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('reports a reference that is not available without Retry or a substitute', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(404, {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        retryable: false,
        correlationId: 'c',
      }),
    );
    renderReader(PSALM_3_ID);
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('That passage is not available in this translation.');
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('offers no previous chapter before Genesis 1 and no next after Revelation 22', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(
        200,
        chapter({
          book: { code: 'GEN', name: 'Genesis', chapterCount: 50 },
          chapter: 1,
          next: { bookCode: 'GEN', bookName: 'Genesis', chapter: 2 },
        }),
      ),
    );
    respond(PSALM_4_ID, () =>
      jsonResponse(
        200,
        chapter({
          book: { code: 'REV', name: 'Revelation', chapterCount: 22 },
          chapter: 22,
          previous: { bookCode: 'REV', bookName: 'Revelation', chapter: 21 },
        }),
      ),
    );
    const { rerender } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Genesis 1' });
    const buttons = () =>
      within(screen.getByRole('navigation', { name: 'Chapters' }))
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(buttons()).toStrictEqual(['Next chapter: Genesis 2']);

    rerender(PSALM_4_ID);
    await screen.findByRole('heading', { name: 'Revelation 22' });
    expect(buttons()).toStrictEqual(['Previous chapter: Revelation 21']);
  });

  it('opens a chosen book and chapter only when Open is pressed', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    const { onOpenChapter } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    const picker = screen.getByRole('form', { name: 'Choose a chapter' });
    expect(within(picker).getByLabelText<HTMLSelectElement>('Book').value).toBe('PSA');
    expect(within(picker).getByLabelText<HTMLSelectElement>('Chapter').value).toBe('3');

    fireEvent.change(within(picker).getByLabelText('Book'), { target: { value: 'JUD' } });
    expect(within(within(picker).getByLabelText('Chapter')).getAllByRole('option')).toHaveLength(1);
    fireEvent.change(within(picker).getByLabelText('Book'), { target: { value: 'REV' } });
    fireEvent.change(within(picker).getByLabelText('Chapter'), { target: { value: '22' } });
    expect(onOpenChapter).not.toHaveBeenCalled();

    fireEvent.click(within(picker).getByRole('button', { name: 'Open' }));
    expect(onOpenChapter).toHaveBeenCalledWith(
      { editionId: EDITION_ID, bookCode: 'REV', chapter: 22 },
      true,
    );
  });

  it('changes translation by reopening the same chapter, without moving focus or writing', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    const { onOpenChapter } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });

    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    expect(onOpenChapter).toHaveBeenCalledWith(
      { editionId: OTHER_EDITION_ID, bookCode: 'PSA', chapter: 3 },
      false,
    );
    // Every request the reader made was a read (the fetch mock throws on anything else).
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('changes translation with nothing open by switching the edition only', () => {
    const { onChangeEdition, onOpenChapter } = renderReader(null);
    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    expect(onChangeEdition).toHaveBeenCalledWith(OTHER_EDITION_ID);
    expect(onOpenChapter).not.toHaveBeenCalled();
  });
});
