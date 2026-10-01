'use client';

import type {
  AnchorSelection,
  BibleChapterLink,
  BibleEditionAttribution,
  BiblePassageResponse,
  BibleTranslation,
} from '@bible-artisan/contracts';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { captureAnchor } from '@/lib/anchors';
import { type ChapterTarget, fetchPassage, passageQueryKey } from '@/lib/bible';
import { ProblemAlert } from './problem-alert';
import {
  type CaptureState,
  PhraseForm,
  type ReaderSelection,
  SelectionBar,
  selectionAnnouncement,
  selectionPayload,
} from './reader-selection';
import {
  type Boundaries,
  boundariesOf,
  phraseFromRange,
  rangesOf,
  sameAnchorSelection,
  sameBoundaries,
  spanOfRanges,
  VERSE_TEXT_ATTRIBUTE,
} from './selection';

/**
 * A deliberate navigation: once the passage for `referenceId` has loaded, its heading takes
 * focus. `n` distinguishes repeated requests for the same reference.
 */
export interface FocusRequest {
  referenceId: string;
  n: number;
}

/**
 * The passage query, shared by the reader and its host (same key, one request): the reference
 * fixes the edition. Retries a transient failure once; never a 4xx, and never 429/503, which the
 * user retries (after `Retry-After`).
 */
export function usePassage(referenceId: string | null) {
  return useQuery({
    queryKey: referenceId ? passageQueryKey(referenceId) : ['bible', 'passage', 'none'],
    queryFn: () => {
      if (!referenceId) throw new Error('no reference');
      return fetchPassage(referenceId);
    },
    enabled: referenceId !== null,
    placeholderData: keepPreviousData,
    retry: (count, error) =>
      count < 1 && !(error instanceof ApiError && (error.status < 500 || error.status === 503)),
  });
}

interface BibleReaderProps {
  translations: BibleTranslation[];
  /** The edition the selectors start from when no passage is shown. */
  editionId: string;
  /** The resolved reference to show (its chapter, with the range marked); null is empty. */
  referenceId: string | null;
  /**
   * Opens a whole chapter chosen by structure. `focus` is true for a deliberate move (Open): the
   * chapter heading takes focus once it loads. A translation change keeps focus where it is.
   */
  onOpenChapter: (target: ChapterTarget, focus: boolean) => void;
  /** Opens a neighboring chapter by its reference id (one request, no resolve). */
  onOpenReference: (referenceId: string) => void;
  /** Switches the edition with nothing open (a translation chosen before any passage). */
  onChangeEdition: (editionId: string) => void;
  /** The latest deliberate navigation, or null; see `FocusRequest`. */
  focusRequest: FocusRequest | null;
}

const NOT_CONTINUOUS_TEXT = 'Select one continuous passage.';

const PASSAGE_COPY = {
  notFound: 'That passage is not available.',
  refused: 'That passage could not be opened.',
  unavailable: "We couldn't load this chapter.",
};

/**
 * The Bible reader (BIB-17, PRD section 11): translation selector, chapter navigation, and one
 * chapter of verbatim text with its attribution beside it. Self-contained, so the study
 * workspace's inspector can mount it with its own reference later. It only reads: changing the
 * translation or chapter writes nothing (FR-BIBLE-007). A failed load keeps the last chapter on
 * screen with Retry (FR-BIBLE-009).
 */
export function BibleReader({
  translations,
  editionId,
  referenceId,
  onOpenChapter,
  onOpenReference,
  onChangeEdition,
  focusRequest,
}: BibleReaderProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const targetRef = useRef<HTMLLIElement>(null);
  const handledFocus = useRef(focusRequest?.n ?? 0);
  const settledOn = useRef<string | null>(null);
  const passage = usePassage(referenceId);

  // The last chapter that loaded stays visible while the next loads and if it fails (PRD
  // section 11: loading never blanks saved content). Derived during render, not in an effect.
  const [lastLoaded, setLastLoaded] = useState<BiblePassageResponse | null>(null);
  if (passage.data && !passage.isPlaceholderData && passage.data !== lastLoaded) {
    setLastLoaded(passage.data);
  }
  const shown = referenceId ? (passage.data ?? lastLoaded) : null;
  const current = Boolean(passage.data) && !passage.isPlaceholderData;
  const shownId = current ? (passage.data?.reference.id ?? null) : null;
  const translation = translations.find((t) => t.id === (shown?.edition.id ?? editionId));

  useEffect(() => {
    // Only once the requested passage itself is on screen, never the one it replaces.
    if (!shownId) return;
    const previous = settledOn.current;
    settledOn.current = shownId;
    if (focusRequest && handledFocus.current !== focusRequest.n) {
      if (focusRequest.referenceId !== shownId) return;
      handledFocus.current = focusRequest.n;
      headingRef.current?.focus();
      targetRef.current?.scrollIntoView?.({ block: 'center' });
      return;
    }
    // Back/Forward (or any move the user did not start here): keep focus where it is when that
    // element is still on the page; never leave it on <body>. The first load moves nothing.
    if (previous === null || previous === shownId) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
  }, [shownId, focusRequest]);

  // Selection (BIB-18) belongs to the passage it was made on: a chapter or translation change
  // clears it (PRD section 14). Derived during render from the key, not reset in an effect.
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);
  const phraseToggleRef = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<{ key: string; value: ReaderSelection } | null>(null);
  // What the live region says about a selection that ended with nothing selected (Clear, or a
  // selection that is not one passage), and the passage it was said on.
  const [notice, setNotice] = useState<{ on: string; text: string } | null>(null);
  const [phraseFormOpen, setPhraseFormOpen] = useState<string | null>(null);
  const passageKey = shown ? passageKeyOf(shown) : null;
  const selection = picked && picked.key === passageKey ? picked.value : null;
  const payload = shown && selection ? selectionPayload(shown, selection) : null;
  const choose = (value: ReaderSelection | null) => {
    setPicked(value && passageKey ? { key: passageKey, value } : null);
    setNotice(null);
  };
  /** Drops the browser's text selection, but only one made in this reader. */
  const clearNativeSelection = () => {
    const native = document.getSelection();
    if (native && native.rangeCount > 0 && selectionIsIn(native, sectionRef.current)) {
      native.removeAllRanges();
    }
  };

  // A new passage replaces the verse list (it is keyed by passage, so no node is reused), and a
  // text selection made on the old one is dropped rather than left pointing into the new text.
  const selectedOn = useRef(passageKey);
  useEffect(() => {
    if (selectedOn.current === passageKey) return;
    selectedOn.current = passageKey;
    const native = document.getSelection();
    if (native && native.rangeCount > 0 && selectionIsIn(native, sectionRef.current)) {
      native.removeAllRanges();
    }
  }, [passageKey]);

  // Native text selection inside the verse list becomes a phrase; see `watchNativeSelection`.
  const lastBoundaries = useRef<Boundaries>([]);
  useEffect(() => {
    if (!shown) return;
    const key = passageKeyOf(shown);
    return watchNativeSelection(listRef, lastBoundaries, shown, (phrase) => {
      if (phrase === 'not_continuous') {
        // Separate stretches of verse text (Ctrl-drag): not one passage, so nothing stays armed,
        // and the live region says why (no reference).
        setPicked(null);
        setNotice({ on: key, text: NOT_CONTINUOUS_TEXT });
        return;
      }
      if (!phrase) {
        // Text selected in the verses that is no verse text (a heading, a "no text" note): no
        // phrase and no ticked verses stay armed from before.
        setPicked(null);
        return;
      }
      setNotice(null);
      setPicked((prev) =>
        prev?.key === key &&
        prev.value.kind === 'phrase' &&
        sameAnchorSelection(prev.value.selection, phrase)
          ? prev
          : { key, value: { kind: 'phrase', selection: phrase } },
      );
    });
  }, [shown]);

  const capture = useMutation({ mutationFn: captureAnchor });
  // The capture shown is the one for exactly this selection; any other selection starts idle.
  const ready = payload !== null && payload !== 'not_contiguous' ? payload : null;
  const captureIsCurrent =
    ready !== null &&
    capture.variables !== undefined &&
    sameAnchorSelection(capture.variables, ready);
  const captureState: CaptureState = !captureIsCurrent
    ? { status: 'idle' }
    : capture.isPending
      ? { status: 'pending' }
      : capture.isError
        ? { status: 'error', error: capture.error }
        : capture.data
          ? { status: 'captured', result: capture.data }
          : { status: 'idle' };
  const startCapture = () => {
    if (ready) capture.mutate(ready);
  };

  const toggleVerse = (verse: number) => {
    const ticked = selection?.kind === 'verses' ? selection.verses : [];
    const next = ticked.includes(verse) ? ticked.filter((v) => v !== verse) : [...ticked, verse];
    choose(next.length > 0 ? { kind: 'verses', verses: next } : null);
    // Ticking replaces a phrase; its highlight would otherwise still show.
    clearNativeSelection();
  };
  const tickedVerses = selection?.kind === 'verses' ? selection.verses : [];
  const showPhraseForm = shown !== null && phraseFormOpen === passageKey;
  const closePhraseForm = () => {
    setPhraseFormOpen(null);
    phraseToggleRef.current?.focus();
  };
  const selectPhrase = (phrase: AnchorSelection) => {
    choose({ kind: 'phrase', selection: phrase });
    setPhraseFormOpen(null);
    // The chosen phrase replaces any text selected in the reader; its highlight would otherwise
    // still show.
    clearNativeSelection();
    // The Selection bar renders with this state; move to its first action once it exists.
    requestAnimationFrame(() => captureButtonRef.current?.focus());
  };

  const target = shown ? targetVerses(shown) : null;
  const loading = referenceId !== null && passage.isFetching && !current;
  // Loading and capture progress are shown as well as announced; the selection is shown in the
  // Selection region, so its announcement is screen-reader only.
  const progress = loading
    ? 'Loading the passage…'
    : captureState.status === 'pending'
      ? 'Capturing the selection…'
      : captureState.status === 'captured'
        ? 'Selection captured.'
        : '';
  const selectionStatus =
    shown && payload !== null
      ? selectionAnnouncement(shown, payload)
      : passageKey !== null && notice?.on === passageKey
        ? notice.text
        : '';
  const status = progress || selectionStatus;

  return (
    <section ref={sectionRef} aria-label="Reader" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <TranslationPicker
          translations={translations}
          editionId={translation?.id ?? editionId}
          onApply={(id) => {
            // References are edition-bound, so the new edition opens the same book and chapter,
            // without the old target. Nothing is written (FR-BIBLE-007).
            if (shown) {
              onOpenChapter(
                { editionId: id, bookCode: shown.book.code, chapter: shown.chapter },
                false,
              );
            } else {
              onChangeEdition(id);
            }
          }}
        />
        {translation ? (
          <ChapterPicker
            translation={translation}
            currentBook={shown?.book.code}
            currentChapter={shown?.chapter}
            onOpen={(bookCode, chapter) =>
              onOpenChapter({ editionId: translation.id, bookCode, chapter }, true)
            }
          />
        ) : null}
      </div>

      {/* One live region, mounted from the first render; only its text changes. */}
      <p role="status" aria-live="polite" className={progress ? 'text-muted' : 'sr-only'}>
        {status}
      </p>
      {passage.isError && referenceId ? (
        <ProblemAlert
          error={passage.error}
          copy={PASSAGE_COPY}
          onRetry={() => void passage.refetch()}
        />
      ) : null}

      {!referenceId ? (
        <p className="text-muted">
          Enter a reference such as Romans 9:1, or choose a book and chapter, to start reading.
        </p>
      ) : null}

      {shown ? (
        <article aria-labelledby="passage-heading" className="flex flex-col gap-3">
          <header className="flex flex-col gap-1">
            <h2 id="passage-heading" ref={headingRef} tabIndex={-1} className="font-serif text-3xl">
              {chapterTitle(shown)}
            </h2>
            <Attribution edition={shown.edition} />
            {target ? (
              <p>
                <span className="font-semibold">{target.label}</span> is marked with a bar beside
                the verse.
              </p>
            ) : null}
          </header>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">
              Select text, tick verses, or choose a phrase word by word.
            </p>
            <div>
              <button
                type="button"
                ref={phraseToggleRef}
                aria-expanded={showPhraseForm}
                onClick={() => (showPhraseForm ? closePhraseForm() : setPhraseFormOpen(passageKey))}
                className="rounded border border-accent px-3 py-1 text-accent"
              >
                Select a phrase
              </button>
            </div>
            {showPhraseForm ? (
              <PhraseForm passage={shown} onSelect={selectPhrase} onCancel={closePhraseForm} />
            ) : null}
            <SelectionBar
              passage={shown}
              payload={payload}
              capture={captureState}
              onCapture={startCapture}
              onClear={() => {
                // Focus stays on Clear (aria-disabled now, still focusable); the live region
                // says what happened.
                choose(null);
                if (passageKey) setNotice({ on: passageKey, text: 'Selection cleared.' });
                clearNativeSelection();
              }}
              captureButtonRef={captureButtonRef}
            />
          </div>
          <Verses
            key={passageKey}
            passage={shown}
            target={target}
            targetRef={targetRef}
            listRef={listRef}
            ticked={tickedVerses}
            onToggle={toggleVerse}
          />
          <ChapterLinks passage={shown} onGo={(link) => onOpenReference(link.referenceId)} />
        </article>
      ) : null}
    </section>
  );
}

/** Whether a native selection starts or ends inside `root`, or points at removed nodes. */
function selectionIsIn(native: Selection, root: Element | null): boolean {
  const ends = [native.anchorNode, native.focusNode];
  return ends.some((node) => node && (!node.isConnected || Boolean(root?.contains(node))));
}

/**
 * Maps the browser's text selection over the verse list to a phrase, at most once per animation
 * frame and never while a pointer is held down (a drag maps once, on release). Keyboard selection
 * (shift+arrow) has no pointer, so its `selectionchange` maps on the next frame. Each mapping
 * first compares the selection's boundary points with the last ones seen and does nothing when
 * they are unchanged, so a release or a repeated event costs a few comparisons.
 *
 * `onPhrase` gets the phrase, or null for a selection inside the list that holds no verse text.
 * A collapsed selection, or one outside the list, leaves the reader's selection alone (so
 * clicking Capture keeps it). Firefox's several ranges are mapped as one span, unless verse text
 * lies between them (a deliberate multi-selection): then `onPhrase` gets `not_continuous`.
 */
function watchNativeSelection(
  listRef: React.RefObject<HTMLOListElement | null>,
  last: React.RefObject<Boundaries>,
  passage: BiblePassageResponse,
  onPhrase: (phrase: AnchorSelection | 'not_continuous' | null) => void,
): () => void {
  let frame = 0;
  let pointerDown = false;
  const map = () => {
    frame = 0;
    const list = listRef.current;
    const native = document.getSelection();
    if (!list || !native) return;
    const ranges = rangesOf(native);
    const boundaries = boundariesOf(ranges);
    if (sameBoundaries(boundaries, last.current)) return;
    last.current = boundaries;
    const span = spanOfRanges(ranges, list);
    if (span === 'not_continuous') {
      onPhrase(span);
      return;
    }
    if (!span || span.collapsed || !span.intersectsNode(list)) return;
    onPhrase(phraseFromRange(span, list, passage));
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(map);
  };
  const onSelectionChange = () => {
    if (!pointerDown) schedule();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 0) pointerDown = true;
  };
  const onPointerUp = () => {
    pointerDown = false;
    schedule();
  };
  // A key press means no drag is in progress (recovers if a release was never delivered).
  const onKeyDown = () => {
    pointerDown = false;
  };
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

/** Identifies the passage a selection was made on: edition, book and chapter. */
function passageKeyOf(passage: BiblePassageResponse): string {
  return `${passage.edition.id} ${passage.book.code} ${passage.chapter}`;
}

function chapterTitle(passage: BiblePassageResponse): string {
  return `${passage.book.name} ${passage.chapter}`;
}

interface Target {
  first: number;
  last: number;
  label: string;
}

/**
 * The verses of this chapter the reference covers. A reference to the whole chapter marks
 * nothing (there is nothing to single out); a range that continues into the next chapter is
 * marked to the end of this one.
 */
function targetVerses(passage: BiblePassageResponse): Target | null {
  const r = passage.reference;
  const lastVerse = passage.verses.length;
  if (r.bookCode !== passage.book.code) return null;
  if (r.startChapter > passage.chapter || r.endChapter < passage.chapter) return null;
  const first = r.startChapter === passage.chapter ? r.startVerse : 1;
  const last = r.endChapter === passage.chapter ? r.endVerse : lastVerse;
  if (first === 1 && last === lastVerse) return null;
  return { first, last, label: r.label };
}

/**
 * The chapter's verses. Each verse's stored text sits alone in a `data-verse-text` element, the
 * only thing a text selection is measured against; the checkbox, verse number, headings and the
 * "no text" note are outside it and cannot be selected into an anchor.
 */
function Verses({
  passage,
  target,
  targetRef,
  listRef,
  ticked,
  onToggle,
}: {
  passage: BiblePassageResponse;
  target: Target | null;
  targetRef: React.RefObject<HTMLLIElement | null>;
  listRef: React.RefObject<HTMLOListElement | null>;
  ticked: readonly number[];
  onToggle: (verse: number) => void;
}) {
  const headings = new Map(passage.superscriptions.map((s) => [s.beforeVerse, s.text]));
  const textAttribute = (verse: number) => ({ [VERSE_TEXT_ATTRIBUTE]: verse });
  return (
    // role="list" keeps list semantics in Safari, which drops them for unstyled lists.
    <ol
      ref={listRef}
      role="list"
      className="flex list-none flex-col gap-2 font-serif text-lg leading-relaxed"
    >
      {passage.verses.map(({ verse, text }) => {
        const marked = target !== null && verse >= target.first && verse <= target.last;
        const heading = headings.get(verse);
        return (
          <li
            key={verse}
            ref={marked && verse === target.first ? targetRef : undefined}
            className={marked ? 'border-l-4 border-accent pl-3' : 'pl-4'}
          >
            {heading !== undefined ? (
              <p className="mb-1 text-base italic text-muted">
                <span className="sr-only">Heading: </span>
                {heading}
              </p>
            ) : null}
            <p>
              <input
                type="checkbox"
                aria-label={`Select verse ${verse}`}
                checked={ticked.includes(verse)}
                onChange={() => onToggle(verse)}
                className="mr-2 size-5 select-none align-middle accent-accent"
              />
              <span
                className={
                  marked
                    ? 'mr-2 select-none font-sans text-sm font-bold'
                    : 'mr-2 select-none font-sans text-sm text-muted'
                }
              >
                <span className="sr-only">{marked ? 'Marked verse ' : 'Verse '}</span>
                {verse}
              </span>
              <span {...textAttribute(verse)}>{text}</span>
              {text === '' ? (
                <span className="select-none font-sans text-base italic text-muted">
                  No text for this verse in this edition.
                </span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Translation attribution, shown beside every display of Scripture (PRD section 20). */
export function Attribution({ edition }: { edition: BibleEditionAttribution }) {
  return (
    <p className="text-sm text-muted">
      {edition.attribution}
      {edition.noticeUrl ? (
        <>
          {' '}
          <a
            href={edition.noticeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            About this translation <span className="sr-only">(opens in a new tab)</span>
          </a>
        </>
      ) : null}
    </p>
  );
}

function ChapterLinks({
  passage,
  onGo,
}: {
  passage: BiblePassageResponse;
  onGo: (link: BibleChapterLink) => void;
}) {
  const { previous, next } = passage;
  return (
    <nav aria-label="Chapters" className="flex flex-wrap justify-between gap-3">
      {previous ? (
        <button
          type="button"
          onClick={() => onGo(previous)}
          className="rounded border border-accent px-3 py-2 text-accent"
        >
          Previous chapter: {previous.bookName} {previous.chapter}
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button
          type="button"
          onClick={() => onGo(next)}
          className="rounded border border-accent px-3 py-2 text-accent"
        >
          Next chapter: {next.bookName} {next.chapter}
        </button>
      ) : null}
    </nav>
  );
}

/**
 * The translation selector. A form with an Apply button, so arrowing through the options never
 * moves the reader by itself (WCAG 3.2.2) or starts overlapping requests.
 */
function TranslationPicker({
  translations,
  editionId,
  onApply,
}: {
  translations: BibleTranslation[];
  editionId: string;
  onApply: (editionId: string) => void;
}) {
  const id = useId();
  // The user's pick, kept until Apply; otherwise the select follows the shown edition.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? editionId;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDraft(null);
    if (value !== editionId) onApply(value);
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Choose a translation"
      className="flex flex-wrap items-end gap-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm">
          Translation
        </label>
        <select
          id={id}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          className="rounded border border-muted bg-canvas px-2 py-2"
        >
          {translations.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.abbreviation})
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded border border-accent px-3 py-2 text-accent">
        Apply
      </button>
    </form>
  );
}

/**
 * Book and chapter selection. A form with an Open button, so changing a select never moves the
 * reader by itself (WCAG 3.2.2). It is never remounted: the selects follow the shown chapter
 * until the user changes one, and keep that choice until Open.
 */
function ChapterPicker({
  translation,
  currentBook,
  currentChapter,
  onOpen,
}: {
  translation: BibleTranslation;
  currentBook?: string;
  currentChapter?: number;
  onOpen: (book: string, chapter: number) => void;
}) {
  const bookId = useId();
  const chapterId = useId();
  const [edit, setEdit] = useState<{ book: string; chapter: number } | null>(null);
  const fallback = translation.books[0]?.code ?? '';
  const chosen = edit ?? { book: currentBook ?? fallback, chapter: currentChapter ?? 1 };
  const bookSummary = translation.books.find((b) => b.code === chosen.book);
  const book = bookSummary ? chosen.book : fallback;
  const chapterCount = bookSummary?.chapterCount ?? translation.books[0]?.chapterCount ?? 1;
  const chapter = bookSummary && chosen.chapter <= chapterCount ? chosen.chapter : 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setEdit(null);
    onOpen(book, chapter);
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Choose a chapter"
      className="flex flex-wrap items-end gap-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={bookId} className="text-sm">
          Book
        </label>
        <select
          id={bookId}
          value={book}
          onChange={(event) => setEdit({ book: event.target.value, chapter: 1 })}
          className="rounded border border-muted bg-canvas px-2 py-2"
        >
          {translation.books.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={chapterId} className="text-sm">
          Chapter
        </label>
        <select
          id={chapterId}
          value={chapter}
          onChange={(event) => setEdit({ book, chapter: Number(event.target.value) })}
          className="rounded border border-muted bg-canvas px-2 py-2"
        >
          {Array.from({ length: chapterCount }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded border border-accent px-3 py-2 text-accent">
        Open
      </button>
    </form>
  );
}
