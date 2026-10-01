import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chapter,
  deferred,
  EDITION_ID,
  OTHER_EDITION_ID,
  OTHER_TRANSLATION,
  PSALM_3,
  PSALM_3_ID,
  PSALM_4,
  PSALM_4_ID,
  TRANSLATION,
  wholeChapterReference,
} from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { BibleReader, type FocusRequest } from './bible-reader';

type Respond = () => Response | Promise<Response>;
let responses: Map<string, Respond[]>;
let fetchMock: ReturnType<typeof vi.fn>;

/** Queue responses per reference id; a request with nothing queued fails the test. */
function respond(referenceId: string, ...make: Respond[]) {
  responses.set(referenceId, [...(responses.get(referenceId) ?? []), ...make]);
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'Server wording that must never be shown.',
  retryable: false,
  correlationId: 'c',
  ...extra,
});

beforeEach(() => {
  responses = new Map();
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (init?.method && init.method !== 'GET') throw new Error('the reader must not write');
    if (!url.pathname.endsWith('/bible/passages')) throw new Error(`unexpected fetch ${input}`);
    // Only the opaque reference id travels in the URL; it fixes the edition.
    expect([...url.searchParams.keys()]).toStrictEqual(['referenceId']);
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
  const onOpenReference = vi.fn();
  const onChangeEdition = vi.fn();
  const props = {
    translations: [TRANSLATION, OTHER_TRANSLATION],
    editionId: EDITION_ID,
    onOpenChapter,
    onOpenReference,
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
  return { ...view, onOpenChapter, onOpenReference, onChangeEdition, rerender };
}

const verseItems = () => within(screen.getByRole('list')).getAllByRole('listitem');
const picker = () => screen.getByRole('form', { name: 'Choose a chapter' });
const selected = (label: string) => within(picker()).getByLabelText<HTMLSelectElement>(label).value;

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

  it('opens the next chapter by the reference id its link carries, in one step', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    const { onOpenReference, onOpenChapter } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter: Psalms 4' }));
    expect(onOpenReference).toHaveBeenCalledWith(PSALM_4_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Previous chapter: Psalms 2' }));
    expect(onOpenReference).toHaveBeenLastCalledWith(PSALM_3.previous?.referenceId);
    expect(onOpenChapter).not.toHaveBeenCalled();
  });

  it('keeps the previous chapter on screen when the next is unavailable (503), and Retry loads it', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    respond(
      PSALM_4_ID,
      () => jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', { retryable: true })),
      () => jsonResponse(200, PSALM_4),
    );
    const { rerender } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });

    // The host asks for focus on Psalm 4 before its URL (and so this reader) has moved: the old
    // heading must not take it.
    const focus = { referenceId: PSALM_4_ID, n: 1 };
    rerender(PSALM_3_ID, focus);
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Psalms 3' }));
    rerender(PSALM_4_ID, focus);

    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe("We couldn't load this chapter.Retry");
    // FR-BIBLE-009: the last chapter stays visible with Retry.
    expect(screen.getByRole('heading', { name: 'Psalms 3' })).toBeTruthy();
    expect(screen.getByText('Placeholder text one.')).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const heading = await screen.findByRole('heading', { name: 'Psalms 4' });
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('holds Retry until Retry-After has passed when rate limited (429)', async () => {
    respond(
      PSALM_3_ID,
      () =>
        jsonResponse(429, envelope('RATE_LIMITED', { retryable: true }), { 'Retry-After': '1' }),
      () => jsonResponse(200, PSALM_3),
    );
    renderReader(PSALM_3_ID);
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('Too many requests right now. You can retry in 1 second.Retry');
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(retry.getAttribute('aria-disabled')).toBeNull(), { timeout: 2500 });
    expect(textOf(alert)).toBe('Too many requests right now.Retry');
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Psalms 3' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-checks the session on 401 so the page sends the user to sign in, with no Retry', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(401, { ...envelope('UNAUTHENTICATED'), message: 'Sign in to continue' }),
    );
    const { queryClient } = renderReader(PSALM_3_ID);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('Your session has ended. Taking you to sign in…');
    expect(within(alert).queryByRole('button')).toBeNull();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] }));
  });

  it('reports a reference that is not available (404) without Retry or a substitute', async () => {
    respond(PSALM_3_ID, () => jsonResponse(404, envelope('NOT_FOUND')));
    renderReader(PSALM_3_ID);
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('That passage is not available.');
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('never renders a server message: an unknown refusal gets fixed copy', async () => {
    respond(PSALM_3_ID, () => jsonResponse(400, envelope('VALIDATION')));
    renderReader(PSALM_3_ID);
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe('That passage could not be opened.');
    expect(screen.queryByText(/Server wording/)).toBeNull();
  });

  it('keeps one status region mounted and changes only its text while a chapter loads', async () => {
    const slow = deferred<Response>();
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    respond(PSALM_4_ID, () => slow.promise);
    const { rerender } = renderReader(null);
    const status = screen.getByRole('status');
    expect(textOf(status)).toBe('');

    rerender(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    expect(screen.getByRole('status')).toBe(status);
    expect(textOf(status)).toBe('');

    rerender(PSALM_4_ID);
    await waitFor(() => expect(textOf(status)).toBe('Loading the passage…'));
    slow.resolve(jsonResponse(200, PSALM_4));
    await screen.findByRole('heading', { name: 'Psalms 4' });
    expect(screen.getByRole('status')).toBe(status);
    expect(textOf(status)).toBe('');
  });

  it('offers no previous chapter before Genesis 1 and no next after Revelation 22', async () => {
    respond(PSALM_3_ID, () =>
      jsonResponse(
        200,
        chapter({
          book: { code: 'GEN', name: 'Genesis', chapterCount: 50 },
          chapter: 1,
          next: { bookCode: 'GEN', bookName: 'Genesis', chapter: 2, referenceId: PSALM_4_ID },
        }),
      ),
    );
    respond(PSALM_4_ID, () =>
      jsonResponse(
        200,
        chapter({
          book: { code: 'REV', name: 'Revelation', chapterCount: 22 },
          chapter: 22,
          previous: {
            bookCode: 'REV',
            bookName: 'Revelation',
            chapter: 21,
            referenceId: PSALM_3_ID,
          },
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
    expect(selected('Book')).toBe('PSA');
    expect(selected('Chapter')).toBe('3');

    fireEvent.change(within(picker()).getByLabelText('Book'), { target: { value: 'JUD' } });
    expect(within(within(picker()).getByLabelText('Chapter')).getAllByRole('option')).toHaveLength(
      1,
    );
    fireEvent.change(within(picker()).getByLabelText('Book'), { target: { value: 'REV' } });
    fireEvent.change(within(picker()).getByLabelText('Chapter'), { target: { value: '22' } });
    expect(onOpenChapter).not.toHaveBeenCalled();

    fireEvent.click(within(picker()).getByRole('button', { name: 'Open' }));
    expect(onOpenChapter).toHaveBeenCalledWith(
      { editionId: EDITION_ID, bookCode: 'REV', chapter: 22 },
      true,
    );
  });

  it('keeps the chapter picker mounted across chapters: it follows the chapter, but never overrides an edit', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    respond(
      PSALM_4_ID,
      () => jsonResponse(200, PSALM_4),
      () => jsonResponse(200, PSALM_4),
    );
    const { rerender } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    const form = picker();

    // Untouched, it follows the chapter on screen, without remounting.
    rerender(PSALM_4_ID);
    await screen.findByRole('heading', { name: 'Psalms 4' });
    expect(picker()).toBe(form);
    expect(selected('Chapter')).toBe('4');

    // Mid-edit, a chapter change keeps the user's choice and keeps focus on the select.
    const bookSelect = within(form).getByLabelText('Book');
    bookSelect.focus();
    fireEvent.change(bookSelect, { target: { value: 'REV' } });
    rerender(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    expect(picker()).toBe(form);
    expect(selected('Book')).toBe('REV');
    expect(selected('Chapter')).toBe('1');
    expect(document.activeElement).toBe(bookSelect);
  });

  it('moves focus to the chapter heading on Back/Forward when focus would fall to the page', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    respond(PSALM_4_ID, () => jsonResponse(200, PSALM_4));
    const { rerender } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    expect(document.activeElement).toBe(document.body); // the first load moves nothing

    // A history move with no focus request (the browser's Back button).
    rerender(PSALM_4_ID);
    const heading = await screen.findByRole('heading', { name: 'Psalms 4' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('switches translation only on Apply: arrowing through the options moves nothing', async () => {
    respond(PSALM_3_ID, () => jsonResponse(200, PSALM_3));
    const { onOpenChapter } = renderReader(PSALM_3_ID);
    await screen.findByRole('heading', { name: 'Psalms 3' });
    const form = screen.getByRole('form', { name: 'Choose a translation' });
    const select = within(form).getByLabelText<HTMLSelectElement>('Translation');

    // Keyboard arrowing fires a change for each option it passes.
    select.focus();
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: OTHER_EDITION_ID } });
    fireEvent.keyDown(select, { key: 'ArrowUp' });
    fireEvent.change(select, { target: { value: EDITION_ID } });
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: OTHER_EDITION_ID } });
    expect(onOpenChapter).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);

    fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    expect(onOpenChapter).toHaveBeenCalledTimes(1);
    expect(onOpenChapter).toHaveBeenCalledWith(
      { editionId: OTHER_EDITION_ID, bookCode: 'PSA', chapter: 3 },
      false,
    );
    // Every request the reader made was a read (the fetch mock throws on anything else).
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('changes translation with nothing open by switching the edition only, on Apply', () => {
    const { onChangeEdition, onOpenChapter } = renderReader(null);
    fireEvent.change(screen.getByLabelText('Translation'), {
      target: { value: OTHER_EDITION_ID },
    });
    expect(onChangeEdition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChangeEdition).toHaveBeenCalledWith(OTHER_EDITION_ID);
    expect(onOpenChapter).not.toHaveBeenCalled();
  });
});
