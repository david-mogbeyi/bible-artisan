import type {
  AnchorSelection,
  BiblePassageResponse,
  CaptureAnchorResponse,
  ScriptureAnchor,
} from '@bible-artisan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chapter,
  OTHER_TRANSLATION,
  PSALM_4,
  PSALM_4_ID,
  TRANSLATION,
} from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { AnchorQuote } from './anchor-quote';
import { BibleReader } from './bible-reader';

/** Synthetic text (AGENTS.md rule 8). */
const PASSAGE_ID = '33333333-2222-4333-8444-555555555555';
const PASSAGE: BiblePassageResponse = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 3,
  verses: [
    { verse: 1, text: 'one two three' },
    { verse: 2, text: 'four five' },
    { verse: 3, text: 'six seven' },
  ],
  reference: {
    id: PASSAGE_ID,
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    startChapter: 3,
    startVerse: 1,
    endChapter: 3,
    endVerse: 3,
    label: 'Psalms 3',
  },
});

const SHA = 'b'.repeat(64);
const reference = (endVerse: number) => ({
  id: '99999999-2222-4333-8444-555555555555',
  editionId: TRANSLATION.id,
  bookCode: 'PSA',
  startChapter: 3,
  startVerse: 1,
  endChapter: 3,
  endVerse,
  label: endVerse === 1 ? 'Psalms 3:1' : `Psalms 3:1–${endVerse}`,
});
const anchorOf = (selection: AnchorSelection): ScriptureAnchor => ({
  version: 1,
  ...selection,
  segments: selection.segments.map((s) => ({ ...s, textSha256: SHA })),
});

let captureReply: (body: AnchorSelection) => Response;
let captured: AnchorSelection[];

beforeEach(() => {
  captured = [];
  captureReply = (body) =>
    jsonResponse(200, {
      anchor: anchorOf(body),
      reference: reference(body.segments[body.segments.length - 1]?.verse ?? 1),
    } satisfies CaptureAnchorResponse);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input);
      // Nothing about the selection ever travels in a URL.
      expect(url.search).not.toMatch(/quote|segments|one|four/);
      if (url.pathname.endsWith('/bible/anchors') && init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('expected a JSON body');
        const body = JSON.parse(init.body) as AnchorSelection;
        captured.push(body);
        return Promise.resolve(captureReply(body));
      }
      if (url.pathname.endsWith('/bible/passages')) {
        const id = url.searchParams.get('referenceId');
        return Promise.resolve(jsonResponse(200, id === PSALM_4_ID ? PSALM_4 : PASSAGE));
      }
      throw new Error(`unexpected fetch ${input}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderReader(referenceId = PASSAGE_ID) {
  const props = {
    translations: [TRANSLATION, OTHER_TRANSLATION],
    editionId: TRANSLATION.id,
    onOpenChapter: vi.fn(),
    onOpenReference: vi.fn(),
    onChangeEdition: vi.fn(),
    focusRequest: null,
  };
  const view = renderWithQuery(<BibleReader {...props} referenceId={referenceId} />);
  await screen.findByRole('heading', { name: 'Psalms 3' });
  const rerender = (next: string) =>
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BibleReader {...props} referenceId={next} />
      </QueryClientProvider>,
    );
  return { ...view, rerender };
}

/** A quote figure: its blockquote and caption, each as a reader hears it. */
function expectQuote(figure: HTMLElement, quote: string, caption: string | null) {
  expect(textOf(figure.querySelector('blockquote'))).toBe(quote);
  const figcaption = figure.querySelector('figcaption');
  expect(figcaption ? textOf(figcaption) : null).toBe(caption);
}

const checkbox = (verse: number) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `Select verse ${verse}` });
const captureButton = () =>
  within(selectionRegion()).getByRole<HTMLButtonElement>('button', { name: 'Capture' });

/** The Selection region stays mounted (no layout shift) and says nothing is selected. */
function expectNothingSelected() {
  const region = selectionRegion();
  expect(textOf(region.querySelector('p'))).toBe('Nothing selected.');
  expect(captureButton().disabled).toBe(true);
}

const selectionRegion = () => screen.getByRole('region', { name: 'Selection' });
const status = () => screen.getAllByRole('status')[0];

describe('verse selection with checkboxes', () => {
  it('ticks contiguous verses and captures them as a whole-verse anchor', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 2' }));
    expect(checkbox(2).checked).toBe(true);
    const region = selectionRegion();
    expect(textOf(region)).toContain('Verses selected: Psalms 3:1–2');
    expect(textOf(region)).toContain('“one two three four five”');

    fireEvent.click(within(region).getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(textOf(status())).toBe('Selection captured.'));
    expect(captured).toStrictEqual([
      {
        editionId: TRANSLATION.id,
        bookCode: 'PSA',
        kind: 'verses',
        segments: [
          { chapter: 3, verse: 1, start: 0, end: 13 },
          { chapter: 3, verse: 2, start: 0, end: 9 },
        ],
        quote: 'one two three four five',
      },
    ]);
    expectQuote(
      within(selectionRegion()).getByRole('figure'),
      '“one two three four five”',
      'Psalms 3:1–2 (World English Bible)',
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it('refuses a gap between ticked verses until it is closed', async () => {
    await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    expect(textOf(selectionRegion())).toContain('Choose verses that are next to each other.');
    expect(captureButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 2' }));
    expect(captureButton().disabled).toBe(false);
  });

  it('clears the selection with Clear and when the chapter changes', async () => {
    const { rerender } = await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 1' }));
    fireEvent.click(within(selectionRegion()).getByRole('button', { name: 'Clear selection' }));
    expectNothingSelected();
    expect(checkbox(1).checked).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 1' }));
    rerender(PSALM_4_ID);
    await screen.findByRole('heading', { name: 'Psalms 4' });
    expectNothingSelected();
  });
});

describe('the keyboard phrase form', () => {
  it('selects a phrase word by word across verses, then moves focus to Capture', async () => {
    await renderReader();
    const toggle = screen.getByRole('button', { name: 'Select a phrase' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const form = screen.getByRole('form', { name: 'Select a phrase' });
    const fromVerse = within(form).getByRole('combobox', { name: 'From verse' });
    expect(document.activeElement).toBe(fromVerse);
    fireEvent.change(within(form).getByRole('combobox', { name: 'First word' }), {
      target: { value: '1' },
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'To verse' }), {
      target: { value: '2' },
    });
    const lastWord = within(form).getByRole('combobox', { name: 'Last word' });
    expect(
      within(lastWord)
        .getAllByRole('option')
        .map((o) => textOf(o)),
    ).toStrictEqual(['1. four', '2. five']);
    fireEvent.change(lastWord, { target: { value: '0' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select phrase' }));

    expect(screen.queryByRole('form', { name: 'Select a phrase' })).toBeNull();
    expect(textOf(selectionRegion())).toContain('Phrase selected in Psalms 3:1–2');
    expect(textOf(selectionRegion())).toContain('“two three four”');
    const capture = captureButton();
    await waitFor(() => expect(document.activeElement).toBe(capture));

    fireEvent.click(capture);
    await waitFor(() => expect(textOf(status())).toBe('Selection captured.'));
    expect(captured).toStrictEqual([
      {
        editionId: TRANSLATION.id,
        bookCode: 'PSA',
        kind: 'phrase',
        segments: [
          { chapter: 3, verse: 1, start: 4, end: 13 },
          { chapter: 3, verse: 2, start: 0, end: 4 },
        ],
        quote: 'two three four',
      },
    ]);
  });

  it('says when the phrase ends before it starts, and Escape returns focus to the toggle', async () => {
    await renderReader();
    const toggle = screen.getByRole('button', { name: 'Select a phrase' });
    fireEvent.click(toggle);
    const form = screen.getByRole('form', { name: 'Select a phrase' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'From verse' }), {
      target: { value: '3' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Select phrase' }));
    expect(textOf(within(form).getByRole('alert'))).toBe('The phrase must end after it starts.');
    expectNothingSelected();

    fireEvent.keyDown(within(form).getByRole('combobox', { name: 'To verse' }), { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Select a phrase' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('native text selection', () => {
  it('turns a text selection in the verses into a phrase, and ignores one elsewhere', async () => {
    await renderReader();
    const verseText = (n: number) => {
      const node = screen.getByRole('list').querySelector(`[data-verse-text="${n}"]`)?.firstChild;
      if (!node) throw new Error('no verse text');
      return node;
    };
    const selection = document.getSelection();
    if (!selection) throw new Error('no selection API');

    act(() => {
      // Backward: from verse 2 back into verse 1.
      selection.setBaseAndExtent(verseText(2), 4, verseText(1), 8);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(textOf(selectionRegion())).toContain('Phrase selected in Psalms 3:1–2');
    expect(textOf(selectionRegion())).toContain('“three four”');

    // A selection outside the verses (the heading) leaves the phrase alone.
    act(() => {
      const heading = screen.getByRole('heading', { name: 'Psalms 3' });
      selection.selectAllChildren(heading);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(textOf(selectionRegion())).toContain('“three four”');
    selection.removeAllRanges();
  });
});

describe('capture failures', () => {
  it('shows fixed copy for a refused capture, never the server message', async () => {
    captureReply = () =>
      jsonResponse(422, {
        code: 'ANCHOR_QUOTE_MISMATCH',
        message: 'Server wording that must never be shown.',
        retryable: false,
        correlationId: 'c',
      });
    await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 1' }));
    fireEvent.click(within(selectionRegion()).getByRole('button', { name: 'Capture' }));
    const alert = await within(selectionRegion()).findByRole('alert');
    expect(textOf(alert)).toBe(
      "This selection doesn't match the text of this translation. Select it again.",
    );
    expect(document.body.textContent).not.toContain('Server wording');
  });
});

describe('AnchorQuote', () => {
  const anchor = anchorOf({
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    kind: 'phrase',
    segments: [{ chapter: 3, verse: 1, start: 4, end: 7 }],
    quote: 'two',
  });

  it('shows a resolved quote with its reference and edition', () => {
    renderWithQuery(
      <AnchorQuote anchor={anchor} label="Psalms 3:1" editionName="World English Bible" />,
    );
    expectQuote(screen.getByRole('figure'), '“two”', 'Psalms 3:1 (World English Bible)');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says an unresolved anchor is unresolved in words, keeps the original quote, and offers Reselect', () => {
    const onReselect = vi.fn();
    const { container } = renderWithQuery(
      <AnchorQuote
        anchor={anchor}
        label="Psalms 3:1"
        editionName="World English Bible"
        unresolved
        onReselect={onReselect}
      />,
    );
    expect(textOf(container.querySelector('p'))).toBe(
      'Unresolved selection. It no longer matches the text of World English Bible, so it is not shown on the passage. Original quote:',
    );
    expectQuote(screen.getByRole('figure'), '“two”', 'Psalms 3:1 (World English Bible)');
    fireEvent.click(screen.getByRole('button', { name: 'Reselect' }));
    expect(onReselect).toHaveBeenCalledTimes(1);
  });

  it('names no edition or reference it no longer has', () => {
    const { container } = renderWithQuery(
      <AnchorQuote anchor={anchor} label={null} editionName={null} unresolved />,
    );
    expect(textOf(container.querySelector('p'))).toBe(
      'Unresolved selection. It no longer matches the text of its original translation, so it is not shown on the passage. Original quote:',
    );
    expectQuote(screen.getByRole('figure'), '“two”', null);
    expect(screen.queryByRole('button', { name: 'Reselect' })).toBeNull();
  });
});
