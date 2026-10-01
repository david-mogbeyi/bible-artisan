import type { BiblePassageResponse } from '@bible-artisan/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapter, OTHER_TRANSLATION, TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { BibleReader } from './bible-reader';
import type * as SelectionModule from './selection';
import { phraseFromRange } from './selection';

/**
 * How often the reader maps the browser's selection (the mapper is spied on, still real): once
 * per frame at most, not during a pointer drag, and not at all when the boundary points have not
 * moved. jsdom has no layout or real pointer drag; these events stand in for a browser's.
 */
vi.mock('./selection', async (importOriginal) => {
  const actual = await importOriginal<typeof SelectionModule>();
  return { ...actual, phraseFromRange: vi.fn(actual.phraseFromRange) };
});
const mapper = vi.mocked(phraseFromRange);

/** Synthetic text (AGENTS.md rule 8). */
const PASSAGE: BiblePassageResponse = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 3,
  verses: [
    { verse: 1, text: 'one two three' },
    { verse: 2, text: 'four five' },
  ],
  reference: {
    id: '33333333-2222-4333-8444-555555555555',
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    startChapter: 3,
    startVerse: 1,
    endChapter: 3,
    endVerse: 2,
    label: 'Psalms 3',
  },
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(200, PASSAGE))),
  );
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

async function renderReader() {
  renderWithQuery(
    <BibleReader
      translations={[TRANSLATION, OTHER_TRANSLATION]}
      editionId={TRANSLATION.id}
      referenceId={PASSAGE.reference.id}
      onOpenChapter={vi.fn()}
      onOpenReference={vi.fn()}
      onChangeEdition={vi.fn()}
      focusRequest={null}
    />,
  );
  await screen.findByRole('heading', { name: 'Psalms 3' });
  mapper.mockClear();
}

const text = (verse: number): Text => {
  const node = screen.getByRole('list').querySelector(`[data-verse-text="${verse}"]`)?.firstChild;
  if (!(node instanceof Text)) throw new Error('no verse text');
  return node;
};
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
/** Moves the selection's focus, as a drag or shift+arrow does, and fires selectionchange. */
function extendTo(node: Node, offset: number) {
  const selection = document.getSelection();
  if (!selection) throw new Error('no selection API');
  act(() => {
    if (selection.rangeCount === 0) selection.collapse(text(1), 0);
    selection.extend(node, offset);
    document.dispatchEvent(new Event('selectionchange'));
  });
}
const summary = () =>
  textOf(within(screen.getByRole('region', { name: 'Selection' })).getAllByRole('paragraph')[0]);

describe('mapping the native selection', () => {
  it('maps keyboard selection (no pointer) once per frame, and skips unchanged boundaries', async () => {
    await renderReader();
    // Shift+arrow, three steps in one frame: one mapping, of the last.
    extendTo(text(1), 1);
    extendTo(text(1), 2);
    extendTo(text(1), 3);
    expect(mapper).not.toHaveBeenCalled();
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(textOf(screen.getByRole('status'))).toBe('Phrase selected in Psalms 3:1.');

    // The same boundaries again (a repeated event, a click release): nothing is mapped.
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    fireEvent.pointerUp(document, { button: 0 });
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(1);

    extendTo(text(2), 4);
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(2);
    expect(summary()).toBe('Phrase selected in Psalms 3:1–2');
  });

  it('does not map while a pointer drag is in progress, then maps once on release', async () => {
    await renderReader();
    fireEvent.pointerDown(text(1).parentElement as Element, { button: 0 });
    extendTo(text(1), 3);
    await nextFrame();
    extendTo(text(2), 2);
    await nextFrame();
    extendTo(text(2), 4);
    await nextFrame();
    expect(mapper).not.toHaveBeenCalled();
    expect(summary()).toBe('Nothing selected.');

    fireEvent.pointerUp(document, { button: 0 });
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(summary()).toBe('Phrase selected in Psalms 3:1–2');
  });

  it('recovers keyboard selection if a pointer release was never delivered', async () => {
    await renderReader();
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true });
    extendTo(text(1), 3);
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(1);
  });

  it('ignores a right-button press', async () => {
    await renderReader();
    fireEvent.pointerDown(document.body, { button: 2 });
    extendTo(text(1), 3);
    await nextFrame();
    expect(mapper).toHaveBeenCalledTimes(1);
  });
});
