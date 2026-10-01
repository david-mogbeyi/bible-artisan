'use client';

import {
  hasForbiddenUserTextCharacter,
  MAX_QUESTION_LENGTH,
  MAX_STUDY_DESCRIPTION_LENGTH,
  MAX_STUDY_TAGS,
  MAX_STUDY_TITLE_LENGTH,
  MAX_TAG_LENGTH,
  normalizeTagName,
  QUESTION_NOT_FOUND,
  type StudyResponse,
  type StudyTag,
  STUDY_UNCHANGED,
  TAG_LIMIT_EXCEEDED,
  tagKey,
  type UpdateStudyRequest,
  type UpdateStudyResponse,
  USER_TEXT_INVALID_CHARACTERS,
} from '@bible-artisan/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { ApiError } from '@/lib/api-client';
import { studyQueryKey, updateStudy } from '@/lib/studies';

export const CONFLICT =
  'This study changed somewhere else, so nothing was saved. Your edits are kept here.';
export const RELOADED =
  'Showing the latest saved study. Your edits are still in the form; save again to apply them.';
export const NOTHING_TO_SAVE = 'There are no changes to save.';
export const QUESTION_GONE = "That question isn't part of this study any more. Reload the study.";
const TITLE_REQUIRED = 'Enter a title.';
const TITLE_TOO_LONG = `Use at most ${MAX_STUDY_TITLE_LENGTH} characters for the title.`;
const DESCRIPTION_TOO_LONG = `Use at most ${MAX_STUDY_DESCRIPTION_LENGTH.toLocaleString('en-US')} characters for the description.`;
const QUESTION_TOO_LONG = `Use at most ${MAX_QUESTION_LENGTH.toLocaleString('en-US')} characters for the question.`;
const BAD_CHARACTERS = 'Remove control or invalid characters.';
export const TAG_ALREADY_ADDED = 'That tag is already on this study.';
const TAG_TOO_LONG = `Use at most ${MAX_TAG_LENGTH} characters for a tag.`;
const TOO_MANY_TAGS = `A study can have at most ${MAX_STUDY_TAGS} tags.`;
const TAGS_INVALID = 'Check the tags: each must be different, short, and plain text.';
const TAG_INVISIBLE = 'Use at least one visible character in a tag.';

const SAVE_COPY: ProblemCopy = {
  notFound: "This study isn't available any more.",
  refused: "Couldn't save the study. Your edits are still here.",
  // A lost response may still have committed: Retry reuses the key, so it never applies twice.
  unavailable:
    "Couldn't confirm the study was saved. Your edits are still here, and Retry won't apply them twice.",
};

const RELOAD_COPY: ProblemCopy = {
  notFound: "This study isn't available any more.",
  refused: "Couldn't load the latest study. Your edits are still here.",
  unavailable: "Couldn't load the latest study. Your edits are still here.",
};

/**
 * The form's working copy. Only page state holds it: never the URL or browser storage. Tags are
 * deltas against the saved tags (as the server takes them), so a save never drops a tag another
 * device added meanwhile.
 */
interface Draft {
  title: string;
  description: string;
  newQuestion: string;
  /** Tag names to add (normalized), in the order typed. */
  tagAdds: string[];
  /** Ids of saved tags to remove. */
  tagRemoves: string[];
}

type FieldName = 'title' | 'description' | 'newQuestion' | 'tags';
type FieldErrors = Partial<Record<FieldName, string>>;

/** What a save sends, without the revision (added from `base` when the request is built). */
type Edit = Omit<UpdateStudyRequest, 'expectedRevision'>;

/** The study state a 200 answers with (everything but the event sequence). */
type SavedState = Omit<UpdateStudyResponse, 'lastEventSequence'>;

const draftOf = (study: StudyResponse): Draft => ({
  title: study.title,
  description: study.description ?? '',
  newQuestion: '',
  tagAdds: [],
  tagRemoves: [],
});

/** A tag as the form lists it: a saved one (with its id) or a pending addition. */
interface ShownTag {
  key: string;
  name: string;
  savedId: string | null;
}

/** Keys of the saved tags the draft keeps (not pending removal). */
const keptKeys = (saved: StudyTag[], draft: Draft): Set<string> =>
  new Set(saved.filter((tag) => !draft.tagRemoves.includes(tag.id)).map((tag) => tagKey(tag.name)));

/**
 * The tags the form shows: the latest saved tags minus pending removals, plus pending additions
 * not already among them. After Reload latest this merges the other device's tags with the
 * user's own pending changes.
 */
export function shownTags(saved: StudyTag[], draft: Draft): ShownTag[] {
  const kept = keptKeys(saved, draft);
  return [
    ...saved
      .filter((tag) => !draft.tagRemoves.includes(tag.id))
      .map((tag) => ({ key: tag.id, name: tag.name, savedId: tag.id })),
    ...draft.tagAdds
      .filter((name) => !kept.has(tagKey(name)))
      .map((name) => ({ key: `new:${tagKey(name)}`, name, savedId: null })),
  ];
}

/** Drops pending tag changes the saved tags already reflect (added, or already gone). */
function pruneTags(draft: Draft, saved: StudyTag[]): Draft {
  const ids = new Set(saved.map((tag) => tag.id));
  const tagRemoves = draft.tagRemoves.filter((id) => ids.has(id));
  const kept = keptKeys(saved, { ...draft, tagRemoves });
  return {
    ...draft,
    tagRemoves,
    tagAdds: draft.tagAdds.filter((name) => !kept.has(tagKey(name))),
  };
}

/**
 * The draft once the server holds `saved`, after a save of `sent` (or a reload, which sent
 * nothing) made against `base`. A field shows the saved value when the draft still holds what
 * that save assumed: the value sent, or for an unsent field the base value (the user never
 * touched it). A field the user changed meanwhile, e.g. typed while the save was in flight,
 * keeps the newer draft, which stays a pending change against the new base.
 */
export function settleDraft(
  draft: Draft,
  base: StudyResponse,
  saved: SavedState,
  sent: Edit,
): Draft {
  const titleAssumed = sent.title ?? base.title;
  const descriptionAssumed =
    sent.description !== undefined ? (sent.description ?? '') : (base.description ?? '');
  const sentQuestion =
    sent.mainQuestion && 'text' in sent.mainQuestion ? sent.mainQuestion.text : null;
  return pruneTags(
    {
      ...draft,
      title: draft.title.trim() === titleAssumed ? saved.title : draft.title,
      description:
        draft.description.trim() === descriptionAssumed
          ? (saved.description ?? '')
          : draft.description,
      newQuestion:
        sentQuestion !== null && draft.newQuestion.trim() === sentQuestion ? '' : draft.newQuestion,
    },
    saved.tags,
  );
}

/**
 * The fields the user changed: the draft compared with `base`, the study as it was when the draft
 * started (or was last saved or reloaded), never with a copy a background refetch brought in. Tag
 * changes are the draft's pending deltas. Null when nothing changed.
 */
export function draftEdit(base: StudyResponse, draft: Draft): Edit | null {
  const edit: Edit = {};
  const title = draft.title.trim();
  if (title !== base.title) edit.title = title;
  const description = draft.description.trim() || null;
  if (description !== base.description) edit.description = description;
  if (draft.tagAdds.length > 0 || draft.tagRemoves.length > 0) {
    edit.tags = {
      ...(draft.tagAdds.length > 0 ? { add: draft.tagAdds } : {}),
      ...(draft.tagRemoves.length > 0 ? { remove: draft.tagRemoves } : {}),
    };
  }
  const question = draft.newQuestion.trim();
  if (question) edit.mainQuestion = { text: question };
  return Object.keys(edit).length > 0 ? edit : null;
}

function validate(edit: Edit): FieldErrors {
  const errors: FieldErrors = {};
  const check = (
    field: FieldName,
    text: string | null | undefined,
    max: number,
    tooLong: string,
  ) => {
    if (text === undefined || text === null) return;
    if (hasForbiddenUserTextCharacter(text)) errors[field] = BAD_CHARACTERS;
    else if (text.length > max) errors[field] = tooLong;
  };
  if (edit.title !== undefined && edit.title === '') errors.title = TITLE_REQUIRED;
  else check('title', edit.title, MAX_STUDY_TITLE_LENGTH, TITLE_TOO_LONG);
  check('description', edit.description, MAX_STUDY_DESCRIPTION_LENGTH, DESCRIPTION_TOO_LONG);
  if (edit.mainQuestion && 'text' in edit.mainQuestion) {
    check('newQuestion', edit.mainQuestion.text, MAX_QUESTION_LENGTH, QUESTION_TOO_LONG);
  }
  return errors;
}

/** The 400 `fieldErrors` as this form's fixed copy (a server message is never shown). */
function serverFieldErrors(body: unknown): FieldErrors | null {
  const fieldErrors = (body as { fieldErrors?: Record<string, unknown> } | null)?.fieldErrors;
  if (!fieldErrors) return null;
  const errors: FieldErrors = {};
  const copy = (value: unknown, tooLong: string) =>
    Array.isArray(value) && value.includes(USER_TEXT_INVALID_CHARACTERS) ? BAD_CHARACTERS : tooLong;
  if (fieldErrors.title) errors.title = copy(fieldErrors.title, TITLE_TOO_LONG);
  if (fieldErrors.description) {
    errors.description = copy(fieldErrors.description, DESCRIPTION_TOO_LONG);
  }
  if (fieldErrors['mainQuestion.text'] || fieldErrors.mainQuestion) {
    errors.newQuestion = copy(fieldErrors['mainQuestion.text'], QUESTION_TOO_LONG);
  }
  if (Object.keys(fieldErrors).some((key) => key === 'tags' || key.startsWith('tags.'))) {
    errors.tags = TAGS_INVALID;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * One request as sent: its exact body (with the `expectedRevision` it was built on) and its
 * Idempotency-Key. Once sent it is frozen: Retry resends it verbatim, so a save whose response
 * was lost after it committed gets the original 200 replayed instead of applying twice.
 */
interface Attempt {
  /** 'draft': built from the form; 'action': a one-click edit (pin, restore the original). */
  kind: 'draft' | 'action';
  body: UpdateStudyRequest;
  key: string;
}

/**
 * Edits a study's title, description, main question, pin and tags (BIB-20, FR-STUDY-003).
 *
 * - Save sends only the fields that differ from `base` (the study as last saved or reloaded),
 *   with `base.revision`, and the tag changes as add/remove deltas.
 * - Pin and "Make the original question main again" save at once, as their own edits.
 * - "Saved" appears only after the server's 200. A failure never clears the form.
 * - A 409 says the study changed elsewhere and offers Reload latest; nothing is resent on its own.
 * - Every request is frozen once sent. After a failure with an unknown outcome (network, 5xx),
 *   Retry, or Save with an unedited draft, resends it byte for byte with the same key, whatever a
 *   background refetch brought in meanwhile. Editing the draft discards it: the next save is a new
 *   request, with a new key, from the current base.
 * - Buttons stay focusable while a save runs (`aria-disabled`), so focus never jumps.
 */
export function StudyEditor({
  study,
  onReload,
}: {
  study: StudyResponse;
  /** Refetches the study into the query cache (after a conflict). */
  onReload: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const ids = {
    title: useId(),
    description: useId(),
    question: useId(),
    tag: useId(),
  };
  // The study the draft is compared with: see `draftEdit`.
  const [base, setBase] = useState<StudyResponse>(study);
  const [draft, setDraft] = useState<Draft>(() => draftOf(study));
  const [tagInput, setTagInput] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  // Which request the problem came from, so Retry repeats that one.
  const [problemFrom, setProblemFrom] = useState<'save' | 'reload'>('save');
  const [saved, setSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [alerts, setAlerts] = useState(0);
  // The request in flight, or the last one whose outcome is unknown. See `Attempt`.
  const frozen = useRef<Attempt | null>(null);
  // The current base, for mutation callbacks that settle the draft against it.
  const latestBase = useRef(base);
  useEffect(() => {
    latestBase.current = base;
  }, [base]);
  const alertRef = useRef<HTMLDivElement>(null);
  const fieldRefs = {
    title: useRef<HTMLInputElement>(null),
    description: useRef<HTMLTextAreaElement>(null),
    newQuestion: useRef<HTMLTextAreaElement>(null),
    tags: useRef<HTMLInputElement>(null),
  };

  const save = useMutation({
    mutationFn: (attempt: Attempt) => updateStudy(study.id, attempt.body, attempt.key),
    onSuccess: (edited: UpdateStudyResponse, attempt) => {
      if (frozen.current === attempt) frozen.current = null;
      const { lastEventSequence: _sequence, ...state } = edited;
      // A replayed 200 can be older than what a background refetch already showed.
      queryClient.setQueryData<StudyResponse>(studyQueryKey(study.id), (old) =>
        old && state.revision >= old.revision ? { ...old, ...state } : old,
      );
      const { expectedRevision: _revision, ...sent } = attempt.body;
      const oldBase = latestBase.current;
      setDraft((current) => settleDraft(current, oldBase, state, sent));
      const nextBase = { ...oldBase, ...state };
      latestBase.current = nextBase;
      setBase(nextBase);
      setSaved(true);
    },
    onError: (error, attempt) => {
      const definite =
        error instanceof ApiError && [400, 404, 409, 422, 428].includes(error.status);
      // A definite refusal wrote nothing, so there is nothing to replay.
      if (definite && frozen.current === attempt) frozen.current = null;
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
      } else if (
        error instanceof ApiError &&
        error.status === 400 &&
        serverFieldErrors(error.body)
      ) {
        showFieldErrors(serverFieldErrors(error.body) ?? {});
        return;
      } else if (
        error instanceof ApiError &&
        error.status === 422 &&
        error.code === TAG_LIMIT_EXCEEDED
      ) {
        showFieldErrors({ tags: TOO_MANY_TAGS });
        return;
      } else if (
        error instanceof ApiError &&
        error.status === 422 &&
        error.code === STUDY_UNCHANGED
      ) {
        setNotice(NOTHING_TO_SAVE);
      } else if (
        error instanceof ApiError &&
        error.status === 422 &&
        error.code === QUESTION_NOT_FOUND
      ) {
        setNotice(QUESTION_GONE);
      } else {
        setProblemFrom('save');
        setProblem(error);
      }
      setAlerts((n) => n + 1);
    },
  });
  const pending = save.isPending || reloading;

  useEffect(() => {
    if (alerts > 0) alertRef.current?.focus();
  }, [alerts]);

  function clearMessages() {
    setFieldErrors({});
    setNotice(null);
    setConflict(false);
    setProblem(null);
    setSaved(false);
  }

  function showFieldErrors(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = (['title', 'description', 'newQuestion', 'tags'] as const).find((f) => errors[f]);
    if (first) fieldRefs[first].current?.focus();
  }

  /** Sends `attempt` (new or frozen) and keeps it frozen until its outcome is known. */
  function dispatch(attempt: Attempt) {
    clearMessages();
    frozen.current = attempt;
    save.mutate(attempt);
  }

  /** The draft discards a frozen form save once the user edits it. */
  function draftEdited() {
    setSaved(false);
    if (frozen.current?.kind === 'draft') frozen.current = null;
  }

  function saveDraft() {
    if (pending) return;
    if (frozen.current?.kind === 'draft') {
      dispatch(frozen.current);
      return;
    }
    clearMessages();
    const edit = draftEdit(base, draft);
    if (!edit) {
      setNotice(NOTHING_TO_SAVE);
      setAlerts((n) => n + 1);
      return;
    }
    const errors = validate(edit);
    if (Object.keys(errors).length > 0) {
      showFieldErrors(errors);
      return;
    }
    dispatch({
      kind: 'draft',
      body: { expectedRevision: base.revision, ...edit },
      key: crypto.randomUUID(),
    });
  }

  function saveAction(edit: Edit) {
    if (pending) return;
    dispatch({
      kind: 'action',
      body: { expectedRevision: base.revision, ...edit },
      key: crypto.randomUUID(),
    });
  }

  function retry() {
    if (pending) return;
    if (frozen.current) dispatch(frozen.current);
    else saveDraft();
  }

  async function reload() {
    if (pending) return;
    setReloading(true);
    try {
      await onReload();
      const fresh = queryClient.getQueryData<StudyResponse>(studyQueryKey(study.id));
      if (fresh) {
        // Rebase: untouched fields follow the reloaded study, the user's edits stay pending.
        const oldBase = latestBase.current;
        setDraft((current) => settleDraft(current, oldBase, fresh, {}));
        latestBase.current = fresh;
        setBase(fresh);
      }
      frozen.current = null;
      clearMessages();
      setNotice(RELOADED);
    } catch (error) {
      // The conflict still stands; say why the reload failed, and Retry reloads again.
      setProblemFrom('reload');
      setProblem(error);
    } finally {
      setReloading(false);
      setAlerts((n) => n + 1);
    }
  }

  const tags = shownTags(study.tags, draft);

  function addTag() {
    const name = normalizeTagName(tagInput);
    setFieldErrors(({ tags: _tags, ...rest }) => rest);
    if (!name) return;
    const key = tagKey(name);
    let error: string | null = null;
    if (hasForbiddenUserTextCharacter(tagInput)) error = BAD_CHARACTERS;
    else if (name.length > MAX_TAG_LENGTH) error = TAG_TOO_LONG;
    else if (!key) error = TAG_INVISIBLE;
    else if (tags.some((tag) => tagKey(tag.name) === key)) error = TAG_ALREADY_ADDED;
    if (error) {
      setFieldErrors((current) => ({ ...current, tags: error }));
      return;
    }
    // Typing a saved tag pending removal, exactly as saved, just keeps it.
    const removed = study.tags.find(
      (tag) => draft.tagRemoves.includes(tag.id) && tag.name === name,
    );
    if (!removed && tags.length >= MAX_STUDY_TAGS) {
      setFieldErrors((current) => ({ ...current, tags: TOO_MANY_TAGS }));
      return;
    }
    draftEdited();
    setDraft((current) =>
      removed
        ? { ...current, tagRemoves: current.tagRemoves.filter((id) => id !== removed.id) }
        : { ...current, tagAdds: [...current.tagAdds, name] },
    );
    setTagInput('');
  }

  function removeTag(tag: ShownTag) {
    draftEdited();
    setDraft((current) =>
      tag.savedId === null
        ? {
            ...current,
            tagAdds: current.tagAdds.filter((name) => tagKey(name) !== tagKey(tag.name)),
          }
        : { ...current, tagRemoves: [...current.tagRemoves, tag.savedId] },
    );
    fieldRefs.tags.current?.focus();
  }

  const update = (field: 'title' | 'description' | 'newQuestion') => (value: string) => {
    draftEdited();
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const describedBy = (...parts: (string | false)[]) =>
    parts.filter((part): part is string => Boolean(part)).join(' ') || undefined;
  const original = study.originalQuestion;
  const mainIsOriginal = original === null || study.mainQuestion?.nodeId === original.nodeId;
  const buttonClass = 'rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60';

  return (
    <section aria-labelledby={`${ids.title}-heading`} className="flex flex-col gap-5">
      <h2 id={`${ids.title}-heading`} className="font-serif text-2xl">
        Edit study
      </h2>

      <div ref={alertRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded border border-accent px-3 py-2"
          >
            <p>{CONFLICT}</p>
            <button
              type="button"
              aria-disabled={pending ? true : undefined}
              onClick={() => void reload()}
              className={buttonClass}
            >
              Reload latest
            </button>
          </div>
        ) : null}
        {notice ? (
          <p role="alert" className="rounded border border-accent px-3 py-2">
            {notice}
          </p>
        ) : null}
        {problem ? (
          <ProblemAlert
            error={problem}
            copy={problemFrom === 'reload' ? RELOAD_COPY : SAVE_COPY}
            onRetry={problemFrom === 'reload' ? () => void reload() : retry}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-pressed={study.pinned}
          aria-disabled={pending ? true : undefined}
          onClick={() => saveAction({ pinned: !study.pinned })}
          className={buttonClass}
        >
          Pin study
        </button>
        <span className="text-sm text-muted">
          {study.pinned ? 'Pinned: shown first in your studies.' : 'Not pinned.'}
        </span>
      </div>

      <form
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          saveDraft();
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.title} className="font-medium">
            Title
          </label>
          <input
            id={ids.title}
            ref={fieldRefs.title}
            value={draft.title}
            onChange={(e) => update('title')(e.target.value)}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={describedBy(
              `${ids.title}-count`,
              Boolean(fieldErrors.title) && `${ids.title}-error`,
            )}
            className="rounded border border-muted px-3 py-2"
          />
          <p id={`${ids.title}-count`} className="text-sm text-muted">
            {draft.title.trim().length}/{MAX_STUDY_TITLE_LENGTH} characters
          </p>
          {fieldErrors.title ? (
            <p id={`${ids.title}-error`} className="text-accent">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.description} className="font-medium">
            Description <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id={ids.description}
            ref={fieldRefs.description}
            value={draft.description}
            onChange={(e) => update('description')(e.target.value)}
            rows={3}
            aria-invalid={fieldErrors.description ? true : undefined}
            aria-describedby={describedBy(
              `${ids.description}-count`,
              Boolean(fieldErrors.description) && `${ids.description}-error`,
            )}
            className="rounded border border-muted px-3 py-2"
          />
          <p id={`${ids.description}-count`} className="text-sm text-muted">
            {draft.description.trim().length.toLocaleString('en-US')}/
            {MAX_STUDY_DESCRIPTION_LENGTH.toLocaleString('en-US')} characters
          </p>
          {fieldErrors.description ? (
            <p id={`${ids.description}-error`} className="text-accent">
              {fieldErrors.description}
            </p>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Main question</legend>
          {!mainIsOriginal && original ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted">
                The main question differs from the question this study started with.
              </p>
              <div>
                <button
                  type="button"
                  aria-disabled={pending ? true : undefined}
                  onClick={() => saveAction({ mainQuestion: { nodeId: original.nodeId } })}
                  className={buttonClass}
                >
                  Make the original question main again
                </button>
              </div>
            </div>
          ) : null}
          <label htmlFor={ids.question}>
            New main question <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id={ids.question}
            ref={fieldRefs.newQuestion}
            value={draft.newQuestion}
            onChange={(e) => update('newQuestion')(e.target.value)}
            rows={2}
            aria-invalid={fieldErrors.newQuestion ? true : undefined}
            aria-describedby={describedBy(
              `${ids.question}-hint`,
              Boolean(fieldErrors.newQuestion) && `${ids.question}-error`,
            )}
            className="rounded border border-muted px-3 py-2"
          />
          <p id={`${ids.question}-hint`} className="text-sm text-muted">
            Saving a new question makes it the main question. The original question is kept.
          </p>
          {fieldErrors.newQuestion ? (
            <p id={`${ids.question}-error`} className="text-accent">
              {fieldErrors.newQuestion}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Tags</legend>
          {tags.length > 0 ? (
            <ul aria-label="Tags on this study" className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <li
                  key={tag.key}
                  className="flex items-center gap-1 rounded border border-muted px-2 py-1"
                >
                  <span className="break-all">{tag.name}</span>
                  {tag.savedId === null ? <span className="sr-only">(not saved yet)</span> : null}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag.name}`}
                    onClick={() => removeTag(tag)}
                    className="rounded px-1 text-accent"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No tags yet.</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor={ids.tag}>Add a tag</label>
              <input
                id={ids.tag}
                ref={fieldRefs.tags}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                autoComplete="off"
                aria-invalid={fieldErrors.tags ? true : undefined}
                aria-describedby={describedBy(
                  `${ids.tag}-hint`,
                  Boolean(fieldErrors.tags) && `${ids.tag}-error`,
                )}
                className="rounded border border-muted px-3 py-2"
              />
            </div>
            <button type="button" onClick={addTag} className={buttonClass}>
              Add tag
            </button>
          </div>
          <p id={`${ids.tag}-hint`} className="text-sm text-muted">
            Up to {MAX_STUDY_TAGS} tags of at most {MAX_TAG_LENGTH} characters. Tags are saved with
            the other changes.
          </p>
          {fieldErrors.tags ? (
            <p id={`${ids.tag}-error`} className="text-accent">
              {fieldErrors.tags}
            </p>
          ) : null}
        </fieldset>

        <p role="status" aria-live="polite" className={pending || saved ? 'text-muted' : 'sr-only'}>
          {save.isPending ? 'Saving…' : reloading ? 'Reloading…' : saved ? 'Saved.' : ''}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            aria-disabled={pending ? true : undefined}
            className="rounded bg-accent px-4 py-2 text-canvas aria-disabled:opacity-60"
          >
            Save changes
          </button>
          <button
            type="button"
            aria-disabled={pending ? true : undefined}
            onClick={() => {
              if (pending) return;
              clearMessages();
              frozen.current = null;
              latestBase.current = study;
              setBase(study);
              setDraft(draftOf(study));
              setTagInput('');
            }}
            className={buttonClass}
          >
            Discard changes
          </button>
        </div>
      </form>
    </section>
  );
}
