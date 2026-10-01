'use client';

import type {
  AnchorSelection,
  BiblePassageResponse,
  CaptureAnchorResponse,
} from '@bible-artisan/contracts';
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AnchorQuote } from './anchor-quote';
import { ProblemAlert } from './problem-alert';
import { phraseFromWords, versesSelection, wordsOf } from './selection';

/**
 * The reader's selection (BIB-18, PRD sections 11 and 14): whole verses ticked with the verse
 * checkboxes, or a phrase (native text selection, or the keyboard "Select a phrase" form). It
 * lives in component state only: never in the URL or browser storage (NFR-PRIV-001).
 */
export type ReaderSelection =
  { kind: 'verses'; verses: number[] } | { kind: 'phrase'; selection: AnchorSelection };

export function selectionPayload(
  passage: BiblePassageResponse,
  selection: ReaderSelection,
): AnchorSelection | 'not_contiguous' | null {
  return selection.kind === 'verses'
    ? versesSelection(passage, selection.verses)
    : selection.selection;
}

/** e.g. `Romans 9:1–3`, from the payload's own verses (one chapter: the reader shows one). */
function selectionLabel(passage: BiblePassageResponse, payload: AnchorSelection): string {
  const first = payload.segments[0]?.verse;
  const last = payload.segments[payload.segments.length - 1]?.verse;
  const verses = first === last ? `${first}` : `${first}–${last}`;
  return `${passage.book.name} ${passage.chapter}:${verses}`;
}

/** The Selection region's one-line summary. */
export function selectionSummary(
  passage: BiblePassageResponse,
  payload: AnchorSelection | 'not_contiguous' | null,
): string {
  if (payload === null) return 'Nothing selected.';
  if (payload === 'not_contiguous') return 'Verses selected';
  return payload.kind === 'verses'
    ? `${payload.segments.length === 1 ? 'Verse' : 'Verses'} selected: ${selectionLabel(passage, payload)}`
    : `Phrase selected in ${selectionLabel(passage, payload)}`;
}

const NOT_CONTIGUOUS = 'Choose verses that are next to each other.';

/**
 * What the reader's live region says about the selection: the summary, with the gap message when
 * the ticked verses are not next to each other. Nothing while nothing is selected (the reader
 * says "Selection cleared." itself after Clear). References only, never the quote.
 */
export function selectionAnnouncement(
  passage: BiblePassageResponse,
  payload: AnchorSelection | 'not_contiguous' | null,
): string {
  if (payload === null) return '';
  if (payload === 'not_contiguous') return `Verses selected. ${NOT_CONTIGUOUS}`;
  return `${selectionSummary(passage, payload)}.`;
}

const CAPTURE_COPY = {
  notFound: 'This translation is no longer available.',
  refused: "This selection doesn't match the text of this translation. Select it again.",
  unavailable: "We couldn't capture the selection.",
};

export interface CaptureState {
  status: 'idle' | 'pending' | 'captured' | 'error';
  result?: CaptureAnchorResponse;
  error?: unknown;
}

/**
 * The selection action menu: what is selected, Capture and Clear. Capture builds a durable anchor
 * on the server; the captured quote is the server's checked anchor, never the client's draft.
 *
 * It sits above the verses and is always mounted, with one-line summary and quote rows, so a
 * pointer selection never pushes the text it is dragging over (only an explicit Capture or tick
 * adds rows, below the buttons). The quote row is truncated visually; screen readers get it whole.
 */
export function SelectionBar({
  passage,
  payload,
  capture,
  onCapture,
  onClear,
  captureButtonRef,
}: {
  passage: BiblePassageResponse;
  payload: AnchorSelection | 'not_contiguous' | null;
  capture: CaptureState;
  onCapture: () => void;
  onClear: () => void;
  captureButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const ready = payload !== null && payload !== 'not_contiguous';
  const quote = ready && payload.quote !== '' ? `“${payload.quote}”` : '';
  // aria-disabled, not `disabled`: a focused button that becomes natively disabled drops focus to
  // <body> (Capture while pending, Clear once it has cleared). These stay focusable and inert.
  const captureOff = !ready || capture.status === 'pending';
  const clearOff = payload === null;

  return (
    <section
      aria-label="Selection"
      className="flex flex-col gap-2 rounded border border-muted px-3 py-2"
    >
      {/* Announced through the reader's live region (`selectionAnnouncement`), not here. */}
      <p className="truncate font-semibold">{selectionSummary(passage, payload)}</p>
      {/* A no-break space keeps the row's height when there is no quote. */}
      <p className="truncate font-serif" aria-hidden={quote === '' ? true : undefined}>
        {quote || '\u00a0'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          ref={captureButtonRef}
          aria-disabled={captureOff ? true : undefined}
          onClick={() => {
            if (!captureOff) onCapture();
          }}
          className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
        >
          Capture
        </button>
        <button
          type="button"
          aria-disabled={clearOff ? true : undefined}
          onClick={() => {
            if (!clearOff) onClear();
          }}
          className="rounded border border-muted px-3 py-1 aria-disabled:opacity-60"
        >
          Clear selection
        </button>
      </div>
      {payload === 'not_contiguous' ? <p>{NOT_CONTIGUOUS}</p> : null}
      {capture.status === 'captured' && capture.result ? (
        <>
          <p>Captured. This selection points to exactly this text in {passage.edition.name}:</p>
          <AnchorQuote
            anchor={capture.result.anchor}
            label={capture.result.reference.label}
            editionName={passage.edition.name}
          />
        </>
      ) : null}
      {capture.status === 'error' ? (
        <ProblemAlert error={capture.error} copy={CAPTURE_COPY} onRetry={onCapture} />
      ) : null}
    </section>
  );
}

/**
 * The keyboard equivalent of dragging across text (WCAG 2.1.1): choose the first and last word,
 * in one verse or across verses. Words are listed verbatim. A form with a submit button, so
 * changing a select never moves anything by itself (WCAG 3.2.2).
 */
export function PhraseForm({
  passage,
  onSelect,
  onCancel,
}: {
  passage: BiblePassageResponse;
  onSelect: (selection: AnchorSelection) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const verses = passage.verses
    .map((v) => ({ verse: v.verse, words: wordsOf(v.text) }))
    .filter((v) => v.words.length > 0);
  const firstVerse = verses[0];
  const [from, setFrom] = useState({ verse: firstVerse?.verse ?? 1, word: 0 });
  const [to, setTo] = useState({
    verse: firstVerse?.verse ?? 1,
    word: Math.max(0, (firstVerse?.words.length ?? 1) - 1),
  });
  const [problem, setProblem] = useState(false);
  const fromVerseRef = useRef<HTMLSelectElement>(null);
  const wordsAt = (verse: number) => verses.find((v) => v.verse === verse)?.words ?? [];
  // Focus moves into the form when it opens.
  useEffect(() => fromVerseRef.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const selection = phraseFromWords(passage, from, to);
    if (!selection) {
      setProblem(true);
      fromVerseRef.current?.focus();
      return;
    }
    onSelect(selection);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  const verseSelect = (
    which: 'from' | 'to',
    value: { verse: number; word: number },
    set: (next: { verse: number; word: number }) => void,
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${which}-verse`} className="text-sm">
        {which === 'from' ? 'From verse' : 'To verse'}
      </label>
      <select
        id={`${id}-${which}-verse`}
        ref={which === 'from' ? fromVerseRef : undefined}
        value={value.verse}
        onChange={(event) => {
          const verse = Number(event.target.value);
          setProblem(false);
          set({ verse, word: which === 'from' ? 0 : Math.max(0, wordsAt(verse).length - 1) });
        }}
        className="rounded border border-muted bg-canvas px-2 py-2"
      >
        {verses.map((v) => (
          <option key={v.verse} value={v.verse}>
            {v.verse}
          </option>
        ))}
      </select>
    </div>
  );
  const wordSelect = (
    which: 'from' | 'to',
    value: { verse: number; word: number },
    set: (next: { verse: number; word: number }) => void,
  ) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-${which}-word`} className="text-sm">
        {which === 'from' ? 'First word' : 'Last word'}
      </label>
      <select
        id={`${id}-${which}-word`}
        value={value.word}
        onChange={(event) => {
          setProblem(false);
          set({ verse: value.verse, word: Number(event.target.value) });
        }}
        className="max-w-full rounded border border-muted bg-canvas px-2 py-2"
      >
        {wordsAt(value.verse).map((w, i) => (
          <option key={`${i}-${w.start}`} value={i}>
            {i + 1}. {w.text}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-label="Select a phrase"
      className="flex flex-col gap-3 rounded border border-muted px-3 py-2"
    >
      <div className="flex flex-wrap items-end gap-2">
        {verseSelect('from', from, setFrom)}
        {wordSelect('from', from, setFrom)}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {verseSelect('to', to, setTo)}
        {wordSelect('to', to, setTo)}
      </div>
      {problem ? <p role="alert">The phrase must end after it starts.</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="rounded border border-accent px-3 py-1 text-accent">
          Select phrase
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}
