'use client';

import {
  ANCHOR_PROBLEM_CODES,
  type AnchorProblemCode,
  type Annotation,
  ANNOTATION_LIMIT_EXCEEDED,
  ANNOTATION_UNCHANGED,
  type BiblePassageResponse,
  type CaptureAnchorResponse,
  EMPTY_NOTE_DOCUMENT,
  HIGHLIGHT_COLOR_NAMES,
  HIGHLIGHT_COLORS,
  type HighlightColor,
  MAX_HIGHLIGHT_LABEL_LENGTH,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  annotationListsKey,
  annotationsQueryKey,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from '@/lib/annotations';
import { ApiError } from '@/lib/api-client';
import { bibleHref } from '@/lib/bible';
import { createNote, noteListsKey } from '@/lib/notes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { AnchorQuote } from './anchor-quote';
import type { CodePointRange } from './code-point-runs';
import { ProblemAlert } from './problem-alert';

/**
 * Highlights in the reader (BIB-24; PRD sections 14, 15; FR-BIBLE-006/007). Shown only while
 * reading in a study (`/bible?study=`). A highlight is drawn only over the edition it was saved on
 * and only while its anchor still matches the stored text; one that no longer matches is listed
 * with its original quote and a Reselect link, never moved to nearby text. Quotes and labels stay
 * in request bodies and component state: never in the URL, browser storage or logs.
 */

/** Tailwind classes per color: pale fills under ink text (contrast well above 4.5:1). */
export const HIGHLIGHT_CLASS: Record<HighlightColor, string> = {
  yellow: 'bg-highlight-yellow',
  green: 'bg-highlight-green',
  blue: 'bg-highlight-blue',
  pink: 'bg-highlight-pink',
};

/** Why an anchor no longer matches, in words (never the quote or offsets). */
const PROBLEM_TEXT: Record<AnchorProblemCode, string> = {
  ANCHOR_EDITION_UNAVAILABLE: 'This translation is no longer available.',
  ANCHOR_VERSE_NOT_FOUND: 'A verse it points to is missing from this translation.',
  ANCHOR_NOT_CONTIGUOUS: 'It no longer covers one continuous passage.',
  ANCHOR_CHECKSUM_MISMATCH: 'The verse text has changed since it was saved.',
  ANCHOR_OFFSET_OUT_OF_RANGE: 'It runs past the end of a verse.',
  ANCHOR_KIND_MISMATCH: 'It no longer covers whole verses.',
  ANCHOR_EMPTY: 'It no longer starts and ends on text.',
  ANCHOR_QUOTE_MISMATCH: 'The saved words no longer match the text.',
};

export function anchorProblemText(code: AnchorProblemCode): string {
  return PROBLEM_TEXT[code];
}

const ANCHOR_CODES: ReadonlySet<string> = new Set(ANCHOR_PROBLEM_CODES);

/** The study the reader is reading in, as the reader needs it. */
export type ReaderStudy = Pick<StudyResponse, 'id' | 'title' | 'revision' | 'lifecycle'>;

export function studyIsWritable(study: ReaderStudy): boolean {
  return study.lifecycle === 'active';
}

/** The study's highlights on the shown chapter (the passage's own reference fixes it). */
export function useChapterHighlights(
  study: ReaderStudy | null,
  passage: BiblePassageResponse | null,
) {
  const referenceId = passage?.reference.id ?? null;
  return useQuery({
    queryKey:
      study && referenceId
        ? annotationsQueryKey(study.id, referenceId)
        : ['studies', 'none', 'annotations'],
    queryFn: () => {
      if (!study || !referenceId) throw new Error('no study or passage');
      return listAnnotations(study.id, referenceId);
    },
    enabled: study !== null && referenceId !== null,
  });
}

/**
 * The resolved highlights to draw over this chapter, per verse, oldest first (a later one is
 * drawn over an earlier one). Only the edition and book shown; an unresolved one is never drawn.
 */
export function highlightRanges(
  passage: BiblePassageResponse,
  items: readonly Annotation[],
): Map<number, CodePointRange<Annotation>[]> {
  const byVerse = new Map<number, CodePointRange<Annotation>[]>();
  for (const item of items) {
    if (item.resolution.outcome !== 'resolved') continue;
    const { anchor } = item.resolution;
    if (anchor.editionId !== passage.edition.id || anchor.bookCode !== passage.book.code) continue;
    for (const segment of anchor.segments) {
      if (segment.chapter !== passage.chapter || segment.start >= segment.end) continue;
      const list = byVerse.get(segment.verse) ?? [];
      list.push({ start: segment.start, end: segment.end, key: item });
      byVerse.set(segment.verse, list);
    }
  }
  return byVerse;
}

/** What a highlight is called in text: its color name, and its label when it has one. */
export function highlightName(item: Pick<Annotation, 'colorToken' | 'label'>): string {
  const color = `${HIGHLIGHT_COLOR_NAMES[item.colorToken]} highlight`;
  return item.label ? `${color}: ${item.label}` : color;
}

/** A color swatch with its name, so color is never the only signal (WCAG 1.4.1). */
function ColorName({ color }: { color: HighlightColor }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className={`inline-block size-3 rounded-sm border border-ink ${HIGHLIGHT_CLASS[color]}`}
      />
      {HIGHLIGHT_COLOR_NAMES[color]}
    </span>
  );
}

/**
 * One Idempotency-Key per logical request: kept, with the exact body, until the outcome is known,
 * so Retry after an unknown outcome resends the identical request and never applies it twice.
 */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string } | null>(null);
  return {
    keyFor(body: unknown): string {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    settle(error?: unknown): void {
      const unknownOutcome =
        error !== undefined &&
        (!(error instanceof ApiError) || error.status >= 500 || error.status === 429);
      if (!unknownOutcome) attempt.current = null;
    },
  };
}

/** A refused change, in fixed copy (never a server message, quote or label). */
function refusal(error: unknown, thing: 'highlight' | 'note' = 'highlight'): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409) {
    return thing === 'note'
      ? 'This study changed somewhere else, so the note was not added. Reload the page and try again.'
      : 'This highlight changed somewhere else, so nothing was saved. Reload the highlights and try again.';
  }
  if (error.status === 404) {
    return thing === 'note'
      ? "This study isn't available."
      : "This highlight isn't available any more.";
  }
  if (error.code === STUDY_ARCHIVED) return `This study is archived, so ${thing}s can’t change.`;
  if (error.code === STUDY_TRASHED) return `This study is in the trash, so ${thing}s can’t change.`;
  if (error.code === ANNOTATION_LIMIT_EXCEEDED) {
    return 'This study already has 2,000 highlights. Delete one to add another.';
  }
  if (error.code !== undefined && ANCHOR_CODES.has(error.code)) {
    return "This selection doesn't match the text of this translation. Select it again.";
  }
  if (error.status === 400) return "This label can't be saved. Use one line of plain text.";
  return null;
}

const SAVE_COPY = {
  notFound: "This highlight isn't available any more.",
  refused: "This change can't be saved.",
  unavailable: "Couldn't save. Retry won't save it twice.",
};

/** A refusal said in words, or the shared alert with Retry for an unknown outcome. */
function SaveProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const text = refusal(error);
  if (text) return <p role="alert">{text}</p>;
  return <ProblemAlert error={error} copy={SAVE_COPY} onRetry={onRetry} />;
}

/** The color radio group and optional label shared by Highlight and Edit. */
function HighlightFields({
  color,
  label,
  onColor,
  onLabel,
}: {
  color: HighlightColor;
  label: string;
  onColor: (color: HighlightColor) => void;
  onLabel: (label: string) => void;
}) {
  const id = useId();
  const length = Array.from(label.trim()).length;
  return (
    <>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="text-sm">Color</legend>
        {HIGHLIGHT_COLORS.map((option) => (
          <label key={option} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${id}-color`}
              value={option}
              checked={color === option}
              onChange={() => onColor(option)}
            />
            <ColorName color={option} />
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-label`} className="text-sm">
          Label (optional)
        </label>
        <input
          id={`${id}-label`}
          value={label}
          onChange={(event) => onLabel(event.target.value)}
          aria-describedby={`${id}-count`}
          className="rounded border border-muted bg-canvas px-2 py-1"
        />
        <p
          id={`${id}-count`}
          className={
            length > MAX_HIGHLIGHT_LABEL_LENGTH ? 'text-sm text-accent' : 'text-sm text-muted'
          }
        >
          {length} / {MAX_HIGHLIGHT_LABEL_LENGTH} characters
        </p>
      </div>
    </>
  );
}

/** After a study change commits: the cached study adopts the new revision. */
function useStudyRevision(studyId: string) {
  const queryClient = useQueryClient();
  return (revision: number) =>
    queryClient.setQueryData<StudyResponse>(studyQueryKey(studyId), (old) =>
      old && revision > old.revision ? { ...old, revision } : old,
    );
}

/**
 * Highlight and Add note for the captured selection (the anchor the server checked). Highlight
 * opens a small form; Add note creates an empty note on this passage in the study.
 */
export function CapturedActions({
  study,
  captured,
  onAnnounce,
}: {
  study: ReaderStudy;
  captured: CaptureAnchorResponse;
  onAnnounce: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const adoptRevision = useStudyRevision(study.id);
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState<HighlightColor>('yellow');
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [noted, setNoted] = useState(false);
  const [noteProblem, setNoteProblem] = useState<unknown>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRadio = useRef<HTMLDivElement>(null);
  const highlightAttempt = useAttempt();
  const noteAttempt = useAttempt();
  const writable = studyIsWritable(study);
  const tooLong = Array.from(label.trim()).length > MAX_HIGHLIGHT_LABEL_LENGTH;

  useEffect(() => {
    if (open) firstRadio.current?.querySelector('input')?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setProblem(null);
    toggleRef.current?.focus();
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (pending || tooLong) return;
    const body = {
      expectedRevision: study.revision,
      anchor: captured.anchor,
      colorToken: color,
      label: label.trim() === '' ? null : label,
    };
    setPending(true);
    setProblem(null);
    try {
      const created = await createAnnotation(study.id, body, highlightAttempt.keyFor(body));
      highlightAttempt.settle();
      adoptRevision(created.studyRevision);
      await queryClient.invalidateQueries({ queryKey: annotationListsKey(study.id) });
      void invalidateLibrary(queryClient);
      setOpen(false);
      setLabel('');
      onAnnounce(`${HIGHLIGHT_COLOR_NAMES[color]} highlight saved on ${captured.reference.label}.`);
      toggleRef.current?.focus();
    } catch (error) {
      highlightAttempt.settle(error);
      setProblem(error);
    } finally {
      setPending(false);
    }
  };

  const addNote = async () => {
    if (pending) return;
    const body = {
      expectedRevision: study.revision,
      targetAnchor: captured.anchor,
      content: EMPTY_NOTE_DOCUMENT,
    };
    setPending(true);
    setNoteProblem(null);
    try {
      const created = await createNote(study.id, body, noteAttempt.keyFor(body));
      noteAttempt.settle();
      adoptRevision(created.studyRevision);
      void queryClient.invalidateQueries({ queryKey: noteListsKey(study.id) });
      void invalidateLibrary(queryClient);
      setNoted(true);
      onAnnounce(`Note added on ${captured.reference.label}.`);
    } catch (error) {
      noteAttempt.settle(error);
      setNoteProblem(error);
    } finally {
      setPending(false);
    }
  };

  if (!writable) {
    return (
      <p className="text-sm text-muted">
        This study is {study.lifecycle === 'archived' ? 'archived' : 'in the trash'}, so new
        highlights and notes can’t be added.
      </p>
    );
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          ref={toggleRef}
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Highlight
        </button>
        <button
          type="button"
          aria-disabled={pending ? true : undefined}
          onClick={() => void addNote()}
          className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
        >
          Add note
        </button>
      </div>
      {open ? (
        <form
          aria-label="Highlight this selection"
          onSubmit={(event) => void save(event)}
          onKeyDown={onKeyDown}
          className="flex flex-col gap-3 rounded border border-muted px-3 py-2"
        >
          <div ref={firstRadio}>
            <HighlightFields color={color} label={label} onColor={setColor} onLabel={setLabel} />
          </div>
          {tooLong ? (
            <p role="alert">A label can have at most {MAX_HIGHLIGHT_LABEL_LENGTH} characters.</p>
          ) : null}
          {problem ? <SaveProblem error={problem} onRetry={() => void save()} /> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              aria-disabled={pending || tooLong ? true : undefined}
              className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Save highlight'}
            </button>
            <button type="button" onClick={close} className="rounded border border-muted px-3 py-1">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {noted ? (
        <p>
          Note added on {captured.reference.label}.{' '}
          <Link href={`/studies/${study.id}`} className="text-accent underline">
            Open study notes
          </Link>
        </p>
      ) : null}
      {noteProblem ? (
        refusal(noteProblem, 'note') ? (
          <p role="alert">{refusal(noteProblem, 'note')}</p>
        ) : (
          <ProblemAlert
            error={noteProblem}
            copy={{
              notFound: "This study isn't available.",
              refused: "This note can't be added.",
              unavailable: "Couldn't add the note. Retry won't add it twice.",
            }}
            onRetry={() => void addNote()}
          />
        )
      ) : null}
    </div>
  );
}

/** One highlight in the chapter list: its name, and Edit / Delete when the study is writable. */
function HighlightItem({
  study,
  passage,
  item,
  onAnnounce,
  onReload,
}: {
  study: ReaderStudy;
  passage: BiblePassageResponse;
  item: Annotation;
  onAnnounce: (text: string) => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState<HighlightColor>(item.colorToken);
  const [label, setLabel] = useState(item.label ?? '');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ error: unknown; retry: () => void } | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editAttempt = useAttempt();
  const deleteAttempt = useAttempt();
  const writable = studyIsWritable(study);
  const { resolution } = item;
  const reference = resolution.reference;
  const tooLong = Array.from(label.trim()).length > MAX_HIGHLIGHT_LABEL_LENGTH;

  useEffect(() => {
    if (editing) formRef.current?.querySelector('input')?.focus();
  }, [editing]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: annotationListsKey(study.id) });

  const saveEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (pending || tooLong) return;
    const body = {
      expectedRevision: item.revision,
      colorToken: color,
      label: label.trim() === '' ? null : label,
    };
    setPending(true);
    setProblem(null);
    try {
      await updateAnnotation(study.id, item.id, body, editAttempt.keyFor(body));
      editAttempt.settle();
      await refresh();
      setEditing(false);
      onAnnounce(`Highlight changed to ${HIGHLIGHT_COLOR_NAMES[color]}.`);
      editRef.current?.focus();
    } catch (error) {
      editAttempt.settle(error);
      if (error instanceof ApiError && error.code === ANNOTATION_UNCHANGED) {
        setEditing(false);
        editRef.current?.focus();
      } else {
        setProblem({ error, retry: () => void saveEdit() });
      }
    } finally {
      setPending(false);
    }
  };

  const confirmDelete = async () => {
    if (pending) return;
    setPending(true);
    setProblem(null);
    const body = { expectedRevision: item.revision };
    try {
      await deleteAnnotation(study.id, item.id, item.revision, deleteAttempt.keyFor(body));
      deleteAttempt.settle();
      dialogRef.current?.close();
      onAnnounce(`${highlightName(item)} deleted.`);
      document.getElementById('chapter-highlights')?.focus();
      await refresh();
    } catch (error) {
      deleteAttempt.settle(error);
      dialogRef.current?.close();
      setProblem({ error, retry: () => void confirmDelete() });
      deleteRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  const openDialog = () => {
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  };
  const closeDialog = () => {
    dialogRef.current?.close();
    deleteRef.current?.focus();
  };

  const ids = { title: useId(), desc: useId() };
  return (
    <li
      className={`flex flex-col gap-2 rounded border px-3 py-2 ${
        resolution.outcome === 'resolved' ? 'border-muted' : 'border-accent'
      }`}
    >
      <p>
        <span className="font-semibold">{reference?.label ?? 'Passage'}</span> ·{' '}
        <ColorName color={item.colorToken} />
        {item.label ? <> · {item.label}</> : null}
      </p>
      {resolution.outcome === 'unresolved' ? (
        <>
          <p>
            This highlight no longer matches the {passage.edition.name} text, so it is not shown on
            the text. {anchorProblemText(resolution.reason)} What was highlighted:
          </p>
          <AnchorQuote
            anchor={resolution.anchor}
            label={reference?.label ?? 'Passage'}
            editionName={passage.edition.name}
          />
          {reference ? (
            <Link
              href={bibleHref(reference.id, study.id)}
              className="self-start text-accent underline"
            >
              Reselect <span className="sr-only">{reference.label}</span>
            </Link>
          ) : null}
        </>
      ) : null}
      {writable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            ref={editRef}
            aria-expanded={editing}
            onClick={() => {
              setColor(item.colorToken);
              setLabel(item.label ?? '');
              setProblem(null);
              setEditing((value) => !value);
            }}
            className="rounded border border-muted px-2 py-1 text-sm"
          >
            Edit <span className="sr-only">{highlightName(item)}</span>
          </button>
          <button
            type="button"
            ref={deleteRef}
            onClick={openDialog}
            className="rounded border border-muted px-2 py-1 text-sm"
          >
            Delete <span className="sr-only">{highlightName(item)}</span>
          </button>
        </div>
      ) : null}
      {editing ? (
        <form
          ref={formRef}
          aria-label={`Edit ${highlightName(item)}`}
          onSubmit={(event) => void saveEdit(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
              editRef.current?.focus();
            }
          }}
          className="flex flex-col gap-3"
        >
          <HighlightFields color={color} label={label} onColor={setColor} onLabel={setLabel} />
          {tooLong ? (
            <p role="alert">A label can have at most {MAX_HIGHLIGHT_LABEL_LENGTH} characters.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              aria-disabled={pending || tooLong ? true : undefined}
              className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                editRef.current?.focus();
              }}
              className="rounded border border-muted px-3 py-1"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {problem ? (
        <>
          <SaveProblem error={problem.error} onRetry={problem.retry} />
          {problem.error instanceof ApiError && problem.error.status === 409 ? (
            <button
              type="button"
              onClick={() => {
                setProblem(null);
                onReload();
              }}
              className="self-start text-accent underline"
            >
              Reload highlights
            </button>
          ) : null}
        </>
      ) : null}
      <dialog
        ref={dialogRef}
        aria-labelledby={ids.title}
        aria-describedby={ids.desc}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        className="rounded border border-muted bg-canvas p-4 text-ink"
      >
        <h3 id={ids.title} className="font-semibold">
          Delete this highlight?
        </h3>
        <p id={ids.desc}>
          {highlightName(item)} on {reference?.label ?? 'this passage'}. The text itself is not
          changed.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={closeDialog}
            className="rounded border border-muted px-3 py-1"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-disabled={pending ? true : undefined}
            onClick={() => void confirmDelete()}
            className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
          >
            Delete highlight
          </button>
        </div>
      </dialog>
    </li>
  );
}

/**
 * The keyboard path for highlights (WCAG 2.1.1): every highlight touching this chapter, by name,
 * with Edit and Delete; then the ones that no longer match the text, with their original quote,
 * the reason in words, and Reselect.
 */
export function ChapterHighlights({
  study,
  passage,
  items,
  onAnnounce,
  onReload,
}: {
  study: ReaderStudy;
  passage: BiblePassageResponse;
  items: readonly Annotation[];
  onAnnounce: (text: string) => void;
  onReload: () => void;
}) {
  const resolved = items.filter((item) => item.resolution.outcome === 'resolved');
  const unresolved = items.filter((item) => item.resolution.outcome === 'unresolved');
  return (
    <section aria-labelledby="chapter-highlights" className="flex flex-col gap-2">
      {/* Focus lands here after a delete removes the item that had it. */}
      <h3 id="chapter-highlights" tabIndex={-1} className="font-semibold">
        Highlights in this chapter
      </h3>
      {resolved.length === 0 ? (
        <p className="text-muted">No highlights in this chapter yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {resolved.map((item) => (
            <HighlightItem
              key={item.id}
              study={study}
              passage={passage}
              item={item}
              onAnnounce={onAnnounce}
              onReload={onReload}
            />
          ))}
        </ul>
      )}
      {unresolved.length > 0 ? (
        <>
          <h4 className="font-semibold">Highlights that no longer match the text</h4>
          <ul className="flex flex-col gap-2">
            {unresolved.map((item) => (
              <HighlightItem
                key={item.id}
                study={study}
                passage={passage}
                item={item}
                onAnnounce={onAnnounce}
                onReload={onReload}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
