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
    { verse: 4, text: 'eight nine' },
    { verse: 5, text: 'ten eleven' },
  ],
  superscriptions: [{ beforeVerse: 1, text: 'Placeholder heading.' }],
  reference: {
    id: PASSAGE_ID,
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    startChapter: 3,
    startVerse: 1,
    endChapter: 3,
    endVerse: 5,
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

let captureReply: (body: AnchorSelection) => Response | Promise<Response>;
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

/** Lets the reader's once-per-frame selection mapping run. */
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/** A browser text selection (as after a drag or shift+arrows), then the frame it is mapped in. */
async function selectText(start: [Node, number], end: [Node, number]) {
  const selection = document.getSelection();
  if (!selection) throw new Error('no selection API');
  act(() => {
    selection.setBaseAndExtent(start[0], start[1], end[0], end[1]);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await nextFrame();
}

const verseText = (n: number): Text => {
  const node = screen.getByRole('list').querySelector(`[data-verse-text="${n}"]`)?.firstChild;
  if (!(node instanceof Text)) throw new Error('no verse text');
  return node;
};

const checkbox = (verse: number) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `Select verse ${verse}` });
const captureButton = () =>
  within(selectionRegion()).getByRole<HTMLButtonElement>('button', { name: 'Capture' });
const clearButton = () =>
  within(selectionRegion()).getByRole<HTMLButtonElement>('button', { name: 'Clear selection' });
/** Inert but focusable: never native `disabled`, which would drop focus to <body>. */
const isOff = (button: HTMLButtonElement) => {
  expect(button.disabled).toBe(false);
  return button.getAttribute('aria-disabled') === 'true';
};

/** The Selection region stays mounted (no layout shift) and says nothing is selected. */
function expectNothingSelected() {
  const region = selectionRegion();
  expect(textOf(region.querySelector('p'))).toBe('Nothing selected.');
  expect(isOff(captureButton())).toBe(true);
  expect(isOff(clearButton())).toBe(true);
  for (const verse of [1, 2, 3, 4, 5]) expect(checkbox(verse).checked).toBe(false);
}

const selectionRegion = () => screen.getByRole('region', { name: 'Selection' });
/** The reader's single live region. */
const status = () => {
  const regions = screen.getAllByRole('status');
  expect(regions).toHaveLength(1);
  return regions[0] as HTMLElement;
};

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
    expect(isOff(captureButton())).toBe(true);
    fireEvent.click(captureButton());
    expect(captured).toStrictEqual([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 2' }));
    expect(isOff(captureButton())).toBe(false);
  });

  it('announces the selection and the gap message through the one live region', async () => {
    await renderReader();
    expect(textOf(status())).toBe('');
    fireEvent.click(checkbox(2));
    expect(textOf(status())).toBe('Verse selected: Psalms 3:2.');
    fireEvent.click(checkbox(5));
    expect(textOf(status())).toBe('Verses selected. Choose verses that are next to each other.');
    // The Selection region shows it, so the live region stays visually hidden.
    expect(status().className).toBe('sr-only');
    fireEvent.click(checkbox(5));
    expect(textOf(status())).toBe('Verse selected: Psalms 3:2.');
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
    expect(textOf(selectionRegion().querySelector('p'))).toBe('Nothing selected.');
  });
});

describe('Capture and Clear keep keyboard focus', () => {
  it('keeps focus on Clear after a keyboard Clear, and says the selection was cleared', async () => {
    await renderReader();
    fireEvent.click(checkbox(1));
    const clear = clearButton();
    clear.focus();
    // Enter or Space on a focused button is a click.
    fireEvent.click(clear);
    expectNothingSelected();
    expect(document.activeElement).toBe(clear);
    expect(textOf(status())).toBe('Selection cleared.');
    // Inert while there is nothing to clear.
    fireEvent.click(clear);
    expect(document.activeElement).toBe(clear);
    expect(textOf(status())).toBe('Selection cleared.');
  });

  it('keeps focus on Capture while pending, after success, and after a failure', async () => {
    let reply: (response: Response) => void = () => undefined;
    captureReply = () => new Promise<Response>((resolve) => (reply = resolve));
    await renderReader();
    fireEvent.click(checkbox(1));
    const capture = captureButton();
    capture.focus();
    fireEvent.click(capture);
    await waitFor(() => expect(textOf(status())).toBe('Capturing the selection…'));
    expect(isOff(capture)).toBe(true);
    expect(document.activeElement).toBe(capture);
    fireEvent.click(capture); // inert while pending: no second request
    expect(captured).toHaveLength(1);

    const body = captured[0] as AnchorSelection;
    act(() => reply(jsonResponse(200, { anchor: anchorOf(body), reference: reference(1) })));
    await waitFor(() => expect(textOf(status())).toBe('Selection captured.'));
    expect(isOff(capture)).toBe(false);
    expect(document.activeElement).toBe(capture);

    // A new selection, and a failed capture of it.
    captureReply = () =>
      jsonResponse(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: 'x',
        retryable: true,
        correlationId: 'c',
      });
    fireEvent.click(checkbox(2));
    capture.focus();
    fireEvent.click(capture);
    await within(selectionRegion()).findByRole('alert');
    expect(document.activeElement).toBe(capture);
    expect(isOff(capture)).toBe(false);
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
    // Backward: from verse 2 back into verse 1.
    await selectText([verseText(2), 4], [verseText(1), 8]);
    expect(textOf(selectionRegion())).toContain('Phrase selected in Psalms 3:1–2');
    expect(textOf(selectionRegion())).toContain('“three four”');
    expect(textOf(status())).toBe('Phrase selected in Psalms 3:1–2.');

    // A selection outside the verses (the heading) leaves the phrase alone.
    const heading = screen.getByRole('heading', { name: 'Psalms 3' });
    await selectText([heading, 0], [heading, 1]);
    expect(textOf(selectionRegion())).toContain('“three four”');
    document.getSelection()?.removeAllRanges();
  });

  it('clears the phrase or ticked verses when text in the verses selects no verse text', async () => {
    await renderReader();
    // The superscription's own text node (after its screen-reader "Heading:" prefix).
    const superscription = screen.getByText('Placeholder heading.').lastChild as Node;
    await selectText([verseText(1), 0], [verseText(1), 3]);
    expect(textOf(selectionRegion())).toContain('“one”');
    await selectText([superscription, 0], [superscription, 5]);
    expectNothingSelected();
    expect(textOf(status())).toBe('');

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(2));
    await selectText([superscription, 1], [superscription, 6]);
    expectNothingSelected();
    expect(textOf(status())).toBe('');
    document.getSelection()?.removeAllRanges();
  });

  it('maps all of a multi-range selection (Firefox splits it around checkboxes and numbers)', async () => {
    await renderReader();
    const part = (verse: number, start: number, end: number) => {
      const r = document.createRange();
      r.setStart(verseText(verse), start);
      r.setEnd(verseText(verse), end);
      return r;
    };
    // jsdom's Selection holds one range, so stand in for Firefox's, out of order on purpose.
    const ranges = [part(2, 0, 9), part(3, 0, 3), part(1, 4, 13)];
    const firefox = {
      rangeCount: ranges.length,
      getRangeAt: (i: number) => ranges[i],
      isCollapsed: false,
      anchorNode: ranges[2]?.startContainer,
      focusNode: ranges[1]?.endContainer,
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(document, 'getSelection').mockReturnValue(firefox);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await nextFrame();
    expect(textOf(selectionRegion())).toContain('Phrase selected in Psalms 3:1–3');
    expect(textOf(selectionRegion())).toContain('“two three four five six”');
  });

  it('drops a text selection when the chapter changes, so it never maps into the new one', async () => {
    const { rerender } = await renderReader();
    const old = verseText(1);
    await selectText([old, 0], [old, 3]);
    expect(textOf(selectionRegion())).toContain('“one”');

    rerender(PSALM_4_ID);
    await screen.findByRole('heading', { name: 'Psalms 4' });
    // The verse list is keyed by passage: no node is reused for the new text.
    expect(old.isConnected).toBe(false);
    expect(document.getSelection()?.rangeCount).toBe(0);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await nextFrame();
    expect(textOf(selectionRegion().querySelector('p'))).toBe('Nothing selected.');
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
});
