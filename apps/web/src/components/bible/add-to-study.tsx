'use client';

import {
  type CaptureAnchorResponse,
  type CreateNodeRequest,
  type CreateNodeResponse,
  type DuplicatePolicy,
  NODE_LIMIT_EXCEEDED,
  REFERENCE_NOT_FOUND,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError, isRetryable } from '@/lib/api-errors';
import { createNode, nodesQueryKey, studyNodeHref } from '@/lib/nodes';
import { fetchStudy, invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { ProblemAlert } from './problem-alert';
import {
  type ReaderStudy,
  studyIsWritable,
  useAttempt,
  useStudyRevision,
} from './study-highlights';

/** Fixed copy, by the passage's reference label only (never the captured quote). */
export const ADD_TO_STUDY_COPY = {
  button: 'Add to study',
  created: (label: string) => `Added ${label} to the study.`,
  focused: (label: string) => `${label} is already in this study. Your visit was recorded.`,
  duplicate: (label: string) => `Added a duplicate of ${label}.`,
  phrase: (label: string, oneVerse: boolean) =>
    `Adds ${label} (the ${oneVerse ? 'verse' : 'verses'} containing your phrase)`,
  separateCopy: 'Add a separate copy',
  show: 'Show in study',
  conflict: 'The study changed somewhere else. Press Add to study again.',
  reference: "That passage isn't available in an active translation.",
  limit: 'This study holds the most nodes it can (2,000), so the passage was not added.',
  archived: 'This study is archived, so passages can’t be added.',
  trashed: 'This study is in the trash, so passages can’t be added.',
  notFound: "This study isn't available.",
} as const;

const UNKNOWN_COPY = {
  notFound: ADD_TO_STUDY_COPY.notFound,
  refused: "This passage can't be added.",
  unavailable: "Couldn't confirm the passage was added. Retry won't add it twice.",
};

/** A definite refusal in words, or null for an outcome Retry should resend. */
function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError) || isRetryable(classifyError(error))) return null;
  if (error.status === 409) return ADD_TO_STUDY_COPY.conflict;
  if (error.status === 404) return ADD_TO_STUDY_COPY.notFound;
  if (error.code === REFERENCE_NOT_FOUND) return ADD_TO_STUDY_COPY.reference;
  if (error.code === NODE_LIMIT_EXCEEDED) return ADD_TO_STUDY_COPY.limit;
  if (error.code === STUDY_ARCHIVED) return ADD_TO_STUDY_COPY.archived;
  if (error.code === STUDY_TRASHED) return ADD_TO_STUDY_COPY.trashed;
  return null;
}

function outcomeText(node: CreateNodeResponse, label: string): string {
  switch (node.outcome) {
    case 'created':
      return ADD_TO_STUDY_COPY.created(label);
    case 'focused_existing':
      return ADD_TO_STUDY_COPY.focused(label);
    case 'explicit_duplicate':
      return ADD_TO_STUDY_COPY.duplicate(label);
  }
}

/**
 * "Add to study" for a captured selection in the reader's study mode (BIB-26; FR-GRAPH-002/003).
 * Adds the Scripture node for the captured reference (a phrase adds the verses containing it;
 * the phrase itself stays a highlight or note anchor). The server answers with one of three
 * outcomes, each announced in text with a "Show in study" link (`/studies/:id?node=<id>`, opaque
 * ids only): a new node, the existing one focused (the visit is recorded; "Add a separate copy"
 * makes a labeled duplicate), or that duplicate. Each request keeps its Idempotency-Key and body
 * until its outcome is known, so Retry never adds twice; a 409 reads the study again and asks to
 * press Add to study again (a new request on the current revision).
 */
export function AddToStudy({
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
  const attempt = useAttempt();
  const hintId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CreateNodeResponse | null>(null);
  const [problem, setProblem] = useState<{ error: unknown; policy?: DuplicatePolicy } | null>(null);
  // The study revision this component last saw committed (its own Add, or a re-read after a
  // 409), until the study prop catches up with it.
  const [knownRevision, setKnownRevision] = useState(study.revision);
  const studyRevision = Math.max(study.revision, knownRevision);
  const { reference } = captured;
  const phrase = captured.anchor.kind === 'phrase';
  const oneVerse =
    reference.startChapter === reference.endChapter && reference.startVerse === reference.endVerse;

  if (!studyIsWritable(study)) return null;

  const catchUp = async () => {
    try {
      // staleTime 0: the cached study may still count as fresh, and a 409 proves it is not.
      const current = await queryClient.fetchQuery({
        queryKey: studyQueryKey(study.id),
        queryFn: () => fetchStudy(study.id),
        staleTime: 0,
      });
      setKnownRevision((known) => Math.max(known, current.revision));
    } catch {
      // The conflict stays on screen; the next press reads the study again.
    }
  };

  const add = async (policy?: DuplicatePolicy) => {
    if (pending) return;
    const body: CreateNodeRequest = {
      type: 'scripture',
      referenceId: reference.id,
      expectedRevision: studyRevision,
      ...(policy ? { duplicatePolicy: policy } : {}),
    };
    setPending(true);
    setProblem(null);
    try {
      const node = await createNode(study.id, body, attempt.keyFor(body));
      attempt.settle();
      adoptRevision(node.studyRevision);
      // The next press (e.g. "Add a separate copy") sends this revision even before the study
      // prop catches up with the cache.
      setKnownRevision((known) => Math.max(known, node.studyRevision));
      void queryClient.invalidateQueries({ queryKey: nodesQueryKey(study.id) });
      void invalidateLibrary(queryClient);
      setResult(node);
      onAnnounce(outcomeText(node, reference.label));
      // "Add a separate copy" goes away with its outcome: keep focus on Add to study.
      if (policy) buttonRef.current?.focus();
    } catch (error) {
      attempt.settle(error);
      if (error instanceof ApiError && error.status === 409) await catchUp();
      setProblem({ error, policy });
    } finally {
      setPending(false);
    }
  };

  const refused = problem ? refusal(problem.error) : null;
  const details = phrase || result || problem;

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        aria-disabled={pending ? true : undefined}
        aria-describedby={phrase ? hintId : undefined}
        onClick={() => void add()}
        className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
      >
        {ADD_TO_STUDY_COPY.button}
      </button>
      {details ? (
        // Full width, so it wraps below the row of actions.
        <div className="flex w-full flex-col gap-2">
          {phrase ? (
            <p id={hintId} className="text-sm text-muted">
              {ADD_TO_STUDY_COPY.phrase(reference.label, oneVerse)}
            </p>
          ) : null}
          {result ? (
            <div className="flex flex-wrap items-center gap-3">
              <p>{outcomeText(result, reference.label)}</p>
              {result.outcome === 'focused_existing' ? (
                <button
                  type="button"
                  aria-disabled={pending ? true : undefined}
                  onClick={() => void add('explicit_duplicate')}
                  className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
                >
                  {ADD_TO_STUDY_COPY.separateCopy}
                </button>
              ) : null}
              <Link href={studyNodeHref(study.id, result.id)} className="text-accent underline">
                {ADD_TO_STUDY_COPY.show}
              </Link>
            </div>
          ) : null}
          {problem ? (
            refused ? (
              <p role="alert">{refused}</p>
            ) : (
              <ProblemAlert
                error={problem.error}
                copy={UNKNOWN_COPY}
                onRetry={() => void add(problem.policy)}
              />
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}
