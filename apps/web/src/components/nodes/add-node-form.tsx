'use client';

import {
  type CreateNodeRequest,
  createNodeRequestSchema,
  type CreateNodeResponse,
  MAX_NODE_TEXT_LENGTH,
  MAX_QUESTION_LENGTH,
  NODE_LIMIT_EXCEEDED,
  NODE_TYPE_NAMES,
  type NodeSummary,
  OBSERVATION_KIND_NAMES,
  OBSERVATION_KINDS,
  type ObservationKind,
  type ReferenceCandidate,
  REFERENCE_NOT_FOUND,
  SCRIPTURE_NODE_EXISTS,
  type ScriptureReference,
  STUDY_ARCHIVED,
  STUDY_NODE_TYPES,
  STUDY_TRASHED,
  type StudyNodeType,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import { fetchTranslations, resolveReference, TRANSLATIONS_QUERY_KEY } from '@/lib/bible';
import { createNode } from '@/lib/nodes';
import {
  EMPTY_SOURCE,
  type FieldErrors,
  fieldErrorsOf,
  SourceFields,
  sourceInputOf,
  TextAreaField,
} from './node-fields';

export const ADD_NODE_COPY = {
  conflict: 'The study changed somewhere else, so the node was not added. Press Create again.',
  unknown: "Couldn't confirm the node was added. Retry won't add it twice.",
  limit: 'This study holds the most nodes it can (2,000), so the node was not added.',
  reference: "That passage isn't available in an active translation.",
  failed: "Couldn't add the node.",
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

type Problem =
  | { kind: 'message'; text: string; retry?: boolean }
  | { kind: 'exists'; label: string; nodeId: string | null };

/**
 * The inline Add node form (BIB-25): a Type radio group of the six types, then that type's
 * fields. A Scripture node is made only from a passage the server resolved (never from typed
 * text). Each request is frozen with its Idempotency-Key and resent verbatim after an unknown
 * outcome; a changed draft is a new request with a new key. Everything typed stays on a refusal.
 */
export function AddNodeForm({
  study,
  nodes,
  onCreated,
  onCancel,
  onShow,
  onLocked,
  onReload,
}: {
  study: StudyResponse;
  nodes: readonly NodeSummary[];
  onCreated: (created: CreateNodeResponse) => void;
  onCancel: () => void;
  onShow: (nodeId: string) => void;
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
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const frozen = useRef<{ json: string; key: string; body: CreateNodeRequest } | null>(null);
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
    if (pending) return;
    let attempt = frozen.current;
    if (!retry || attempt === null) {
      const body = requestOf();
      if (!body) return;
      const json = JSON.stringify(body);
      attempt = attempt?.json === json ? attempt : { json, key: crypto.randomUUID(), body };
      frozen.current = attempt;
    }
    setPending(true);
    setProblem(null);
    try {
      const created = await createNode(study.id, attempt.body, attempt.key);
      frozen.current = null;
      onCreated(created);
    } catch (error) {
      const definite = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (definite) frozen.current = null;
      setProblem(problemOf(error, definite));
    } finally {
      setPending(false);
    }
  }

  function problemOf(error: unknown, definite: boolean): Problem {
    if (!definite || !(error instanceof ApiError)) {
      return { kind: 'message', text: ADD_NODE_COPY.unknown, retry: true };
    }
    if (error.status === 409) {
      void onReload();
      return { kind: 'message', text: ADD_NODE_COPY.conflict };
    }
    if (error.code === SCRIPTURE_NODE_EXISTS && passage.state === 'resolved') {
      const existing = nodes.find((node) => node.referenceId === passage.reference.id);
      return { kind: 'exists', label: passage.reference.label, nodeId: existing?.id ?? null };
    }
    if (error.code === NODE_LIMIT_EXCEEDED) return { kind: 'message', text: ADD_NODE_COPY.limit };
    if (error.code === REFERENCE_NOT_FOUND) {
      return { kind: 'message', text: ADD_NODE_COPY.reference };
    }
    if (error.code === STUDY_ARCHIVED || error.code === STUDY_TRASHED) {
      // The section turns read-only and says why; this form closes with it.
      onLocked();
      return { kind: 'message', text: ADD_NODE_COPY.failed };
    }
    if (error.status === 400) {
      const body = error.body as { fieldErrors?: Record<string, string[]> } | undefined;
      setErrors(
        Object.fromEntries(
          Object.keys(body?.fieldErrors ?? {}).map((key) => [key, 'Check this field.']),
        ),
      );
    }
    return { kind: 'message', text: ADD_NODE_COPY.failed };
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
            {problem.kind === 'exists' ? (
              <>
                <p>{problem.label} is already in this study.</p>
                {problem.nodeId ? (
                  <button
                    type="button"
                    onClick={() => problem.nodeId && onShow(problem.nodeId)}
                    className="underline"
                  >
                    Show it
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <p>{problem.text}</p>
                {problem.retry ? (
                  <button type="button" onClick={() => void submit(true)} className="underline">
                    Retry
                  </button>
                ) : null}
              </>
            )}
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
