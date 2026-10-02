'use client';

import {
  type CaptureAnchorResponse,
  type CreateNodeResponse,
  type DuplicatePolicy,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import {
  type AddProblem,
  addProblemText,
  NODE_ADD_COPY,
  outcomeText,
  scriptureRequest,
  useAddNode,
} from '@/lib/add-node';
import { ApiError } from '@/lib/api-client';
import { nodesQueryKey, studyNodeHref } from '@/lib/nodes';
import { fetchStudy, invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { ProblemAlert } from './problem-alert';
import { type ReaderStudy, studyIsWritable, useStudyRevision } from './study-highlights';

/** The reader's own copy; outcomes and refusals are `NODE_ADD_COPY`'s, shared with the study page. */
export const ADD_TO_STUDY_COPY = {
  button: 'Add to study',
  phrase: (label: string, oneVerse: boolean) =>
    `Adds ${label} (the ${oneVerse ? 'verse' : 'verses'} containing your phrase)`,
  show: 'Show in study',
} as const;

const UNKNOWN_COPY = {
  notFound: NODE_ADD_COPY.notFound,
  refused: NODE_ADD_COPY.failed,
  unavailable: NODE_ADD_COPY.unknown,
};

/** A definite refusal in words, or null for `ProblemAlert` (unknown outcome, session). */
function refusal(problem: AddProblem, policy: DuplicatePolicy | undefined): string | null {
  if (problem.kind === 'unknown' || problem.kind === 'unauthenticated') return null;
  return addProblemText(
    problem,
    policy === 'explicit_duplicate' ? NODE_ADD_COPY.separateCopy : ADD_TO_STUDY_COPY.button,
  );
}

/**
 * "Add to study" for a captured selection in the reader's study mode (BIB-26; FR-GRAPH-002/003).
 * Adds the Scripture node for the captured reference (a phrase adds the verses containing it;
 * the phrase itself stays a highlight or note anchor). The server answers with one of three
 * outcomes, each announced in text with a "Show in study" link (`/studies/:id?node=<id>`, opaque
 * ids only): a new node, the existing one focused (the visit is recorded; "Add a separate copy"
 * makes a labeled duplicate), or that duplicate. Requests go through `useAddNode`: Retry resends
 * the frozen request (body, revision and Idempotency-Key) verbatim, so it never adds twice even
 * if the study's revision moved meanwhile; a 409 reads the study again and asks to press the
 * button again (a new request on the current revision).
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
  const request = useAddNode<DuplicatePolicy | undefined>(study.id);
  const hintId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { pending } = request;
  const [result, setResult] = useState<CreateNodeResponse | null>(null);
  const [problem, setProblem] = useState<{
    error: unknown;
    reason: AddProblem;
    policy: DuplicatePolicy | undefined;
  } | null>(null);
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

  /** A deliberate press (`policy` set) or, with `retry`, the frozen request again verbatim. */
  const add = async (policy?: DuplicatePolicy, retry = false) => {
    const sent = retry
      ? request.retry()
      : request.send(scriptureRequest(reference.id, studyRevision, policy), policy);
    if (!sent) return;
    setProblem(null);
    const outcome = await sent;
    if (!outcome.ok) {
      if (outcome.error instanceof ApiError && outcome.error.status === 409) await catchUp();
      setProblem({ error: outcome.error, reason: outcome.problem, policy: outcome.meta });
      return;
    }
    const { node } = outcome;
    adoptRevision(node.studyRevision);
    // The next press (e.g. "Add a separate copy") sends this revision even before the study
    // prop catches up with the cache.
    setKnownRevision((known) => Math.max(known, node.studyRevision));
    void queryClient.invalidateQueries({ queryKey: nodesQueryKey(study.id) });
    void invalidateLibrary(queryClient);
    setResult(node);
    onAnnounce(outcomeText(node, reference.label));
    // "Add a separate copy" goes away with its outcome: keep focus on Add to study.
    if (outcome.meta) buttonRef.current?.focus();
  };

  const refused = problem ? refusal(problem.reason, problem.policy) : null;
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
                  {NODE_ADD_COPY.separateCopy}
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
                onRetry={() => void add(problem.policy, true)}
              />
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}
