'use client';

import {
  type CreateStudyRequest,
  hasForbiddenUserTextCharacter,
  MAX_QUESTION_LENGTH,
  MAX_STUDY_TITLE_LENGTH,
  REFERENCE_NOT_FOUND,
  type ReferenceCandidate,
  type ScriptureReference,
  USER_TEXT_INVALID_CHARACTERS,
} from '@bible-artisan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { RequireAuth } from '@/components/require-auth';
import { ApiError } from '@/lib/api-client';
import { classifyError, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import { fetchTranslations, resolveReference, TRANSLATIONS_QUERY_KEY } from '@/lib/bible';
import { createStudy, invalidateLibrary, studyHref } from '@/lib/studies';

export const START_RULE = 'Add a question or a starting passage, or start a blank study.';
export const BLANK_RULE =
  'A blank study has no question or starting passage. Clear them, or choose Create study.';
export const OFFLINE =
  "You're offline. Your draft is kept on this page; create the study when you're back online.";
const TITLE_TOO_LONG = `Use at most ${MAX_STUDY_TITLE_LENGTH} characters for the title.`;
const QUESTION_TOO_LONG = `Use at most ${MAX_QUESTION_LENGTH.toLocaleString('en-US')} characters for the question.`;
export const TITLE_BAD_CHARACTERS = 'Remove control or invalid characters from the title.';
export const QUESTION_BAD_CHARACTERS = 'Remove control or invalid characters from the question.';
const NOT_A_REFERENCE = "That isn't a Bible reference. Try a form like Rom 9:1.";
const PASSAGE_UNAVAILABLE =
  "That passage isn't available in an active translation. Look it up again.";
const PASSAGE_UNCHECKED = 'Check the passage before creating the study.';

const CREATE_COPY: ProblemCopy = {
  notFound: "Couldn't create the study. Your draft is still here.",
  refused: "Couldn't create the study. Your draft is still here.",
  // A lost response may still have committed: Retry reuses the key, so it never duplicates.
  unavailable:
    "Couldn't confirm the study was created. Your draft is still here, and Retry won't create a duplicate.",
};
const TRANSLATIONS_COPY: ProblemCopy = {
  notFound: "Couldn't load the translations, so the passage can't be checked.",
  refused: "Couldn't load the translations, so the passage can't be checked.",
  unavailable: "Couldn't load the translations, so the passage can't be checked.",
};
const RESOLVE_COPY: ProblemCopy = {
  notFound: "Couldn't check the passage.",
  refused: "Couldn't check the passage.",
  unavailable: "Couldn't check the passage.",
};

/** Where the starting passage stands, for the text and translation it was checked against. */
type Passage =
  | { state: 'unchecked' }
  | { state: 'checking' }
  | { state: 'resolved'; reference: ScriptureReference }
  | { state: 'ambiguous'; candidates: ReferenceCandidate[] }
  | { state: 'invalid'; message: string }
  | { state: 'failed'; error: unknown };

type FieldErrors = Partial<Record<'title' | 'question' | 'passage', string>>;

/**
 * The last submission. Its key is reused only for a byte-identical body, so a retry of an
 * unchanged draft can never create a second study, and an edited draft (a different body) always
 * gets a new key, so the server never sees one key with two bodies (422 IDEMPOTENCY_KEY_REUSED).
 */
interface Attempt {
  json: string;
  key: string;
}

/** A passage check that is running or has resolved, for the text and edition it was asked for. */
interface Check {
  text: string;
  edition: string;
  token: number;
  result: Promise<ScriptureReference | null>;
}

/** `/studies/new` (PRD section 11, New Study). */
export function NewStudyPage() {
  return <RequireAuth>{() => <NewStudyForm />}</RequireAuth>;
}

/**
 * Starts a study from an optional title, question and starting passage, or an explicit Blank
 * Study (BIB-19). The passage is resolved inline through `POST /bible/resolve`, so only its
 * shared reference id is sent. Every input stays in the form whatever goes wrong, and only page
 * state holds the draft (nothing in the URL or browser storage). A retry of the same draft reuses
 * its Idempotency-Key, so it can never create a second study.
 */
export function NewStudyForm() {
  const router = useRouter();
  const ids = { title: useId(), question: useId(), passage: useId(), translation: useId() };
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [passageText, setPassageText] = useState('');
  const [chosenEdition, setChosenEdition] = useState<string | null>(null);
  const [passage, setPassage] = useState<Passage>({ state: 'unchecked' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  // Bumped whenever a form-level message appears, so a repeat still moves focus to it.
  const [alerts, setAlerts] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const lastCheck = useRef(0);
  // The current check, shared by blur and submit so one passage is resolved once.
  const currentCheck = useRef<Check | null>(null);
  // True from a submit until its request is sent (or refused locally), covering the passage
  // check, so a second press in that window cannot send a second request.
  const submitting = useRef(false);
  // Which button the last submission came from, so Retry repeats it on the current draft.
  const lastBlank = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const fieldRefs = {
    title: useRef<HTMLInputElement>(null),
    question: useRef<HTMLTextAreaElement>(null),
    passage: useRef<HTMLInputElement>(null),
  };

  const queryClient = useQueryClient();
  const translations = useQuery({ queryKey: TRANSLATIONS_QUERY_KEY, queryFn: fetchTranslations });
  const editions = translations.data?.translations ?? [];
  const editionId = chosenEdition ?? editions[0]?.id ?? null;

  const create = useMutation({
    mutationFn: ({ body, key }: { body: CreateStudyRequest; key: string }) =>
      createStudy(body, key),
    onSuccess: ({ studyId }) => {
      attempt.current = null;
      // The new study belongs in every library listing (Home's recent studies, /studies).
      void invalidateLibrary(queryClient);
      router.push(studyHref(studyId));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) {
        const mapped = serverFieldErrors(error.body);
        if (mapped) {
          showFieldErrors(mapped.fields, mapped.rule);
          return;
        }
      }
      if (error instanceof ApiError && error.status === 422 && error.code === REFERENCE_NOT_FOUND) {
        setPassage({ state: 'invalid', message: PASSAGE_UNAVAILABLE });
        showFieldErrors({ passage: PASSAGE_UNAVAILABLE });
        return;
      }
      setProblem(error);
      setAlerts((n) => n + 1);
    },
  });
  const pending = create.isPending || create.isSuccess;

  useEffect(() => {
    if (alerts > 0) alertRef.current?.focus();
  }, [alerts]);

  function showFieldErrors(errors: FieldErrors, rule: string | null = null) {
    setFieldErrors(errors);
    setFormError(rule);
    const first = (['title', 'question', 'passage'] as const).find((name) => errors[name]);
    if (first) fieldRefs[first].current?.focus();
    else if (rule) setAlerts((n) => n + 1);
  }

  /**
   * Resolves the passage text in an edition; the latest check wins over any earlier answer. A
   * check for the same text and edition that is still running, or has resolved, is reused, so
   * leaving the field and pressing Create sends one resolve request, not two. Editing the passage
   * or the translation bumps `lastCheck`, which retires it.
   */
  function checkPassage(text: string, edition: string): Promise<ScriptureReference | null> {
    const current = currentCheck.current;
    if (
      current &&
      current.token === lastCheck.current &&
      current.text === text &&
      current.edition === edition
    ) {
      return current.result;
    }
    const token = ++lastCheck.current;
    const result = runCheck(text, edition, token).then((reference) => {
      // Only a resolved reference stays reusable: a correction or a failure is checked afresh.
      if (!reference && currentCheck.current?.token === token) currentCheck.current = null;
      return reference;
    });
    currentCheck.current = { text, edition, token, result };
    return result;
  }

  async function runCheck(
    text: string,
    edition: string,
    token: number,
  ): Promise<ScriptureReference | null> {
    setPassage({ state: 'checking' });
    try {
      const result = await resolveReference(text, edition);
      if (token !== lastCheck.current) return null;
      if (result.outcome === 'resolved') {
        setPassage({ state: 'resolved', reference: result.reference });
        setFieldErrors(({ passage: _passage, ...rest }) => rest);
        return result.reference;
      }
      setPassage(
        result.outcome === 'ambiguous'
          ? { state: 'ambiguous', candidates: result.candidates }
          : { state: 'invalid', message: NOT_A_REFERENCE },
      );
    } catch (error) {
      if (token !== lastCheck.current) return null;
      const kind = classifyError(error);
      setPassage(
        kind.kind === 'reference'
          ? { state: 'invalid', message: REFERENCE_ERROR_COPY[kind.code] }
          : { state: 'failed', error },
      );
    }
    return null;
  }

  function editPassage(text: string) {
    lastCheck.current += 1;
    setPassageText(text);
    setPassage({ state: 'unchecked' });
  }

  function pickCandidate(candidate: ReferenceCandidate) {
    if (!editionId) return;
    setPassageText(candidate.input);
    void checkPassage(candidate.input, editionId);
    fieldRefs.passage.current?.focus();
  }

  function send(body: CreateStudyRequest) {
    const json = JSON.stringify(body);
    const key =
      attempt.current && attempt.current.json === json ? attempt.current.key : crypto.randomUUID();
    attempt.current = { json, key };
    setProblem(null);
    create.mutate({ body, key });
  }

  async function submit(blank: boolean) {
    if (pending || submitting.current) return;
    submitting.current = true;
    lastBlank.current = blank;
    try {
      await prepareAndSend(blank);
    } finally {
      submitting.current = false;
    }
  }

  /** Validates the draft, resolves the passage if needed (superseding a running check), sends. */
  async function prepareAndSend(blank: boolean) {
    setFieldErrors({});
    setFormError(null);
    setProblem(null);
    if (!navigator.onLine) {
      setFormError(OFFLINE);
      setAlerts((n) => n + 1);
      return;
    }
    const t = title.trim();
    const q = question.trim();
    const p = passageText.trim();
    const errors: FieldErrors = {};
    if (t.length > MAX_STUDY_TITLE_LENGTH) errors.title = TITLE_TOO_LONG;
    if (q.length > MAX_QUESTION_LENGTH) errors.question = QUESTION_TOO_LONG;
    if (hasForbiddenUserTextCharacter(t)) errors.title = TITLE_BAD_CHARACTERS;
    if (hasForbiddenUserTextCharacter(q)) errors.question = QUESTION_BAD_CHARACTERS;
    const rule = blank ? (q || p ? BLANK_RULE : null) : !q && !p ? START_RULE : null;
    if (Object.keys(errors).length > 0 || rule) {
      showFieldErrors(errors, rule);
      return;
    }
    const titled = t ? { title: t } : {};
    if (blank) {
      send({ blank: true, ...titled });
      return;
    }
    let referenceId: string | undefined;
    if (p) {
      const reference =
        passage.state === 'resolved'
          ? passage.reference
          : editionId
            ? await checkPassage(p, editionId)
            : null;
      if (!reference) {
        // The check says why (a correction, candidates, or a failure); without a translation
        // there was nothing to check against.
        if (editionId) fieldRefs.passage.current?.focus();
        else showFieldErrors({ passage: PASSAGE_UNCHECKED });
        return;
      }
      referenceId = reference.id;
    }
    send({
      ...titled,
      ...(q ? { question: q } : {}),
      ...(referenceId ? { startingReferenceId: referenceId } : {}),
    });
  }

  /**
   * Retry submits the draft as it is now, the way the failed press did (blank or not). `send`
   * keeps the key when the body is unchanged and takes a new one when the draft was edited.
   */
  function retry() {
    void submit(lastBlank.current);
  }

  const describedBy = (...parts: (string | false)[]) =>
    parts.filter((part): part is string => Boolean(part)).join(' ') || undefined;
  const passageMessage =
    fieldErrors.passage ?? (passage.state === 'invalid' ? passage.message : null);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
      <h1 className="font-serif text-4xl">New study</h1>
      <p className="text-muted">
        Start from a passage, a question, or both. You can change the title later.
      </p>

      <div ref={alertRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {formError ? (
          <p role="alert" className="rounded border border-accent px-3 py-2">
            {formError}
          </p>
        ) : null}
        {problem ? <ProblemAlert error={problem} copy={CREATE_COPY} onRetry={retry} /> : null}
      </div>

      <form
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void submit(false);
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.title} className="font-medium">
            Title <span className="text-muted">(optional)</span>
          </label>
          <input
            id={ids.title}
            ref={fieldRefs.title}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={describedBy(
              `${ids.title}-count`,
              Boolean(fieldErrors.title) && `${ids.title}-error`,
            )}
            className="rounded border border-muted px-3 py-2"
          />
          <p id={`${ids.title}-count`} className="text-sm text-muted">
            {title.trim().length}/{MAX_STUDY_TITLE_LENGTH} characters. Without a title, the study is
            named after its passage or question.
          </p>
          {fieldErrors.title ? (
            <p id={`${ids.title}-error`} className="text-accent">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.question} className="font-medium">
            Question <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id={ids.question}
            ref={fieldRefs.question}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder="What is conscience?"
            aria-invalid={fieldErrors.question ? true : undefined}
            aria-describedby={describedBy(
              `${ids.question}-count`,
              Boolean(fieldErrors.question) && `${ids.question}-error`,
            )}
            className="rounded border border-muted px-3 py-2"
          />
          <p id={`${ids.question}-count`} className="text-sm text-muted">
            {question.trim().length.toLocaleString('en-US')}/
            {MAX_QUESTION_LENGTH.toLocaleString('en-US')} characters
          </p>
          {fieldErrors.question ? (
            <p id={`${ids.question}-error`} className="text-accent">
              {fieldErrors.question}
            </p>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">
            Starting passage <span className="text-muted">(optional)</span>
          </legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor={ids.passage}>Passage</label>
              <input
                id={ids.passage}
                ref={fieldRefs.passage}
                value={passageText}
                onChange={(e) => editPassage(e.target.value)}
                onBlur={() => {
                  const text = passageText.trim();
                  if (text && editionId && passage.state === 'unchecked') {
                    void checkPassage(text, editionId);
                  }
                }}
                placeholder="Rom 9:1"
                autoComplete="off"
                aria-invalid={passageMessage ? true : undefined}
                aria-describedby={describedBy(
                  `${ids.passage}-status`,
                  Boolean(passageMessage) && `${ids.passage}-error`,
                )}
                className="rounded border border-muted px-3 py-2"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.translation}>Translation</label>
              <select
                id={ids.translation}
                value={editionId ?? ''}
                onChange={(e) => {
                  setChosenEdition(e.target.value);
                  lastCheck.current += 1;
                  setPassage({ state: 'unchecked' });
                }}
                className="rounded border border-muted px-3 py-2"
              >
                {editions.length === 0 ? <option value="">Loading…</option> : null}
                {editions.map((edition) => (
                  <option key={edition.id} value={edition.id}>
                    {edition.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p id={`${ids.passage}-status`} role="status" className="text-sm text-muted">
            {passage.state === 'checking'
              ? 'Checking the passage…'
              : passage.state === 'resolved'
                ? `Starting passage: ${passage.reference.label}`
                : 'One passage from one book, for example Rom 9:1 or John 3:16-18.'}
          </p>
          {passageMessage ? (
            <p id={`${ids.passage}-error`} className="text-accent">
              {passageMessage}
            </p>
          ) : null}
          {passage.state === 'ambiguous' ? (
            <div role="group" aria-label="Which book did you mean?" className="flex flex-col gap-2">
              <p>Which book did you mean?</p>
              <ul className="flex flex-wrap gap-2">
                {passage.candidates.map((candidate) => (
                  <li key={candidate.bookCode}>
                    <button
                      type="button"
                      onClick={() => pickCandidate(candidate)}
                      className="rounded border border-accent px-3 py-1 text-accent"
                    >
                      {candidate.bookName}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {passage.state === 'failed' ? (
            <ProblemAlert
              error={passage.error}
              copy={RESOLVE_COPY}
              onRetry={() => {
                const text = passageText.trim();
                if (text && editionId) void checkPassage(text, editionId);
              }}
            />
          ) : null}
          {translations.isError ? (
            <ProblemAlert
              error={translations.error}
              copy={TRANSLATIONS_COPY}
              onRetry={() => void translations.refetch()}
            />
          ) : null}
        </fieldset>

        <p role="status" aria-live="polite" className={pending ? 'text-muted' : 'sr-only'}>
          {create.isSuccess ? 'Study created. Opening it…' : pending ? 'Creating study…' : ''}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            aria-disabled={pending ? true : undefined}
            className="rounded bg-accent px-4 py-2 text-canvas aria-disabled:opacity-60"
          >
            Create study
          </button>
          <button
            type="button"
            aria-disabled={pending ? true : undefined}
            onClick={() => void submit(true)}
            className="rounded border border-accent px-4 py-2 text-accent aria-disabled:opacity-60"
          >
            Start a blank study
          </button>
          <Link href="/" className="text-accent underline">
            Cancel
          </Link>
          <Link href="/bible" className="text-accent underline">
            Open the Bible first
          </Link>
        </div>
      </form>
    </main>
  );
}

/**
 * The 400 `fieldErrors` mapped onto this form's fields, in fixed copy (a server message is never
 * shown). Null when the body names nothing this form can point at.
 */
function serverFieldErrors(body: unknown): { fields: FieldErrors; rule: string | null } | null {
  const fieldErrors = (body as { fieldErrors?: Record<string, unknown> } | null)?.fieldErrors;
  if (!fieldErrors) return null;
  const fields: FieldErrors = {};
  const copy = (errors: unknown, bad: string, tooLong: string): string =>
    Array.isArray(errors) && errors.includes(USER_TEXT_INVALID_CHARACTERS) ? bad : tooLong;
  if (fieldErrors.title)
    fields.title = copy(fieldErrors.title, TITLE_BAD_CHARACTERS, TITLE_TOO_LONG);
  if (fieldErrors.question) {
    fields.question = copy(fieldErrors.question, QUESTION_BAD_CHARACTERS, QUESTION_TOO_LONG);
  }
  if (fieldErrors.startingReferenceId) fields.passage = PASSAGE_UNAVAILABLE;
  const rule = fieldErrors._ ? START_RULE : fieldErrors.blank ? BLANK_RULE : null;
  return Object.keys(fields).length > 0 || rule ? { fields, rule } : null;
}
