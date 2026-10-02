'use client';

import {
  type CreateNodeRequest,
  createNodeRequestSchema,
  type CreateNodeResponse,
  MAX_NODE_TEXT_LENGTH,
  MAX_QUESTION_LENGTH,
  NODE_TYPE_NAMES,
  OBSERVATION_KIND_NAMES,
  OBSERVATION_KINDS,
  type ObservationKind,
  type ReferenceCandidate,
  type ScriptureReference,
  STUDY_NODE_TYPES,
  type StudyNodeType,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { addProblemText, isLifecycleRefusal, useAddNode } from '@/lib/add-node';
import { classifyError, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import { fetchTranslations, resolveReference, TRANSLATIONS_QUERY_KEY } from '@/lib/bible';
import {
  EMPTY_SOURCE,
  type FieldErrors,
  fieldErrorsOf,
  SourceFields,
  sourceInputOf,
  TextAreaField,
} from './node-fields';

/** The form's own copy; an add's outcomes and refusals are `NODE_ADD_COPY`'s. */
export const ADD_NODE_COPY = {
  notReference: "That isn't a Bible reference. Try a book and chapter, for example Rom 9:1.",
  resolveFailed: "Couldn't check the passage. Try again.",
  unresolved: 'Resolve the passage before creating the node.',
} as const;

type Passage =
  | { state: 'unchecked' }
  | { state: 'checking' }
  | { state: 'resolved'; reference: ScriptureReference }
  | { state: 'ambiguous'; candidates: ReferenceCandidate[] }
  | { state: 'invalid'; message: string };

interface Problem {
  text: string;
  retry?: boolean;
}

/**
 * The inline Add node form (BIB-25): a Type radio group of the six types, then that type's
 * fields. A Scripture node is made only from a passage the server resolved (never from typed
 * text). Requests go through `useAddNode`: each is frozen with its Idempotency-Key and Retry
 * resends it verbatim after an unknown outcome; Create is a new request with a new key. Everything typed stays on a refusal.
 * A passage the study already holds is not a refusal (BIB-26): the server answers
 * `focused_existing`, and `onCreated` gets every outcome with the passage's label.
 */
export function AddNodeForm({
  study,
  onCreated,
  onCancel,
  onLocked,
  onReload,
}: {
  study: StudyResponse;
  /** `label`: the resolved passage's reference label for a Scripture node, else null. */
  onCreated: (created: CreateNodeResponse, label: string | null) => void;
  onCancel: () => void;
  onLocked: () => void;
  onReload: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const ids = { form: useId(), passage: useId(), kind: useId() };
  const [type, setType] = useState<StudyNodeType>('thought');
  const [text, setText] = useState('');
  const [observationKind, setObservationKind] = useState<ObservationKind>('textual_observation');
  const [source, setSource] = useState(EMPTY_SOURCE);
  const [passageText, setPassageText] = useState('');
  const [passage, setPassage] = useState<Passage>({ state: 'unchecked' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const add = useAddNode<string | null>(study.id);
  const { pending } = add;
  const checkedType = useRef<HTMLInputElement>(null);
  const lastCheck = useRef(0);

  // The study's starting-passage edition, else the first active translation.
  const translations = useQuery({
    queryKey: TRANSLATIONS_QUERY_KEY,
    queryFn: fetchTranslations,
    enabled: type === 'scripture',
  });
  const editionId =
    study.startingReference?.editionId ?? translations.data?.translations[0]?.id ?? null;
  const editionName = (id: string) =>
    translations.data?.translations.find((t) => t.id === id)?.name ?? null;

  useEffect(() => {
    checkedType.current?.focus();
  }, []);

  async function checkPassage(input: string) {
    const trimmed = input.trim();
    if (trimmed === '') return;
    const token = ++lastCheck.current;
    setPassage({ state: 'checking' });
    try {
      const edition =
        editionId ??
        (
          await queryClient.ensureQueryData({
            queryKey: TRANSLATIONS_QUERY_KEY,
            queryFn: fetchTranslations,
          })
        ).translations[0]?.id;
      if (!edition) throw new Error('no active translation');
      const result = await resolveReference(trimmed, edition);
      if (token !== lastCheck.current) return;
      setPassage(
        result.outcome === 'resolved'
          ? { state: 'resolved', reference: result.reference }
          : result.outcome === 'ambiguous'
            ? { state: 'ambiguous', candidates: result.candidates }
            : { state: 'invalid', message: ADD_NODE_COPY.notReference },
      );
    } catch (error) {
      if (token !== lastCheck.current) return;
      const kind = classifyError(error);
      setPassage({
        state: 'invalid',
        message:
          kind.kind === 'reference' ? REFERENCE_ERROR_COPY[kind.code] : ADD_NODE_COPY.resolveFailed,
      });
    }
  }

  function pickCandidate(candidate: ReferenceCandidate) {
    setPassageText(candidate.input);
    void checkPassage(candidate.input);
  }

  /** The request this draft makes, or null with the field errors shown. */
  function requestOf(): CreateNodeRequest | null {
    const expectedRevision = study.revision;
    let body: CreateNodeRequest;
    switch (type) {
      case 'scripture':
        if (passage.state !== 'resolved') {
          setErrors({ referenceId: ADD_NODE_COPY.unresolved });
          return null;
        }
        body = { type, expectedRevision, referenceId: passage.reference.id };
        break;
      case 'observation':
        body = { type, expectedRevision, text, observationKind };
        break;
      case 'source':
        body = { type, expectedRevision, source: sourceInputOf(source) };
        break;
      default:
        body = { type, expectedRevision, text };
    }
    const parsed = createNodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error.issues));
      return null;
    }
    setErrors({});
    return body;
  }

  async function submit(retry = false) {
    let request: ReturnType<typeof add.send>;
    if (retry) {
      // Verbatim: the frozen body, revision and Idempotency-Key, whatever changed since.
      request = add.retry();
    } else {
      const body = requestOf();
      if (!body) return;
      const label =
        body.type === 'scripture' && passage.state === 'resolved' ? passage.reference.label : null;
      request = add.send(body, label);
    }
    if (!request) return;
    setProblem(null);
    const result = await request;
    if (result.ok) {
      onCreated(result.node, result.meta);
      return;
    }
    const { problem: reason } = result;
    if (reason.kind === 'conflict') void onReload();
    if (isLifecycleRefusal(reason)) {
      // The section turns read-only, says why and takes focus; this form closes with it.
      onLocked();
      return;
    }
    if (reason.kind === 'invalid') {
      setErrors(Object.fromEntries(reason.fields.map((key) => [key, 'Check this field.'])));
    }
    setProblem({
      text: addProblemText(reason, 'Create'),
      retry: reason.kind === 'unknown',
    });
  }

  const isStatement = type === 'question' || type === 'conclusion';
  const scriptureBlocked = type === 'scripture' && passage.state !== 'resolved';

  return (
    <section
      aria-labelledby={`${ids.form}-heading`}
      className="flex flex-col gap-4 rounded border border-muted p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <h3 id={`${ids.form}-heading`} className="font-serif text-xl">
        Add a node
      </h3>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Type</legend>
          <div className="flex flex-wrap gap-4">
            {STUDY_NODE_TYPES.map((option) => (
              <label key={option} className="flex items-center gap-2">
                <input
                  ref={option === type ? checkedType : undefined}
                  type="radio"
                  name={`${ids.form}-type`}
                  value={option}
                  checked={type === option}
                  onChange={() => {
                    setType(option);
                    setErrors({});
                    setProblem(null);
                  }}
                />
                {NODE_TYPE_NAMES[option]}
              </label>
            ))}
          </div>
        </fieldset>

        {type === 'scripture' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.passage} className="font-medium">
              Passage
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={ids.passage}
                value={passageText}
                onChange={(event) => {
                  lastCheck.current += 1;
                  setPassageText(event.target.value);
                  setPassage({ state: 'unchecked' });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void checkPassage(passageText);
                  }
                }}
                aria-describedby={`${ids.passage}-status${errors.referenceId ? ` ${ids.passage}-error` : ''}`}
                aria-invalid={errors.referenceId ? true : undefined}
                className="min-w-0 flex-1 rounded border border-muted bg-canvas px-2 py-1"
              />
              <button
                type="button"
                onClick={() => void checkPassage(passageText)}
                className="rounded border border-accent px-3 py-1 text-accent"
              >
                Resolve
              </button>
            </div>
            <p id={`${ids.passage}-status`} role="status" className="text-sm text-muted">
              {passage.state === 'checking'
                ? 'Checking the passage…'
                : passage.state === 'resolved'
                  ? `Resolved: ${passage.reference.label}${
                      editionName(passage.reference.editionId)
                        ? ` (${editionName(passage.reference.editionId)})`
                        : ''
                    }`
                  : 'One passage from one book, for example Rom 9:1.'}
            </p>
            {passage.state === 'invalid' ? <p className="text-accent">{passage.message}</p> : null}
            {passage.state === 'ambiguous' ? (
              <div
                role="group"
                aria-label="Which book did you mean?"
                className="flex flex-col gap-2"
              >
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
            {errors.referenceId ? (
              <p id={`${ids.passage}-error`} className="text-accent">
                {errors.referenceId}
              </p>
            ) : null}
          </div>
        ) : null}

        {isStatement ? (
          <TextAreaField
            label="Statement"
            value={text}
            onChange={setText}
            max={MAX_QUESTION_LENGTH}
            error={errors.text}
          />
        ) : null}

        {type === 'observation' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Kind</legend>
            <div className="flex flex-wrap gap-4">
              {OBSERVATION_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${ids.kind}-observation-kind`}
                    value={kind}
                    checked={observationKind === kind}
                    onChange={() => setObservationKind(kind)}
                  />
                  {OBSERVATION_KIND_NAMES[kind]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {type === 'observation' || type === 'thought' ? (
          <TextAreaField
            label="Text"
            value={text}
            onChange={setText}
            max={MAX_NODE_TEXT_LENGTH}
            error={errors.text}
          />
        ) : null}

        {type === 'source' ? (
          <SourceFields value={source} onChange={setSource} errors={errors} />
        ) : null}

        {problem ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p>{problem.text}</p>
            {problem.retry ? (
              <button type="button" onClick={() => void submit(true)} className="underline">
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            aria-disabled={pending || scriptureBlocked ? true : undefined}
            onClick={(event) => {
              if (pending || scriptureBlocked) event.preventDefault();
            }}
            className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-muted px-3 py-1"
          >
            Cancel
          </button>
        </div>
        {scriptureBlocked ? <p className="text-sm text-muted">{ADD_NODE_COPY.unresolved}</p> : null}
      </form>
    </section>
  );
}
