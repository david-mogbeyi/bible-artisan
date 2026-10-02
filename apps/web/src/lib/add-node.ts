'use client';

import {
  type CreateNodeRequest,
  type CreateNodeResponse,
  type DuplicatePolicy,
  NODE_LIMIT_EXCEEDED,
  REFERENCE_NOT_FOUND,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { useRef, useState } from 'react';
import { ApiError } from './api-client';
import { classifyError, isRetryable } from './api-errors';
import { createNode } from './nodes';

/**
 * Adding a node, and in particular a Scripture node with a duplicate policy (BIB-25/26), shared by
 * the Add node form, the "Add a separate copy" revisit status and the reader's Add to study: one
 * request lifecycle (`useAddNode`), one refusal mapper (`addProblemOf`) and one copy table
 * (`NODE_ADD_COPY`). All copy is fixed and names a passage by its reference label only (never a
 * quote, never a server message).
 */

export const NODE_ADD_COPY = {
  created: (label: string) => `Added ${label} to the study.`,
  focused: (label: string) => `${label} is already in this study. Your visit was recorded.`,
  duplicate: (label: string) => `Added a duplicate of ${label}.`,
  separateCopy: 'Add a separate copy',
  /** `action`: the button that makes a new request on the study's current revision. */
  conflict: (action: string) =>
    `The study changed somewhere else, so the node was not added. Press ${action} again.`,
  unknown: "Couldn't confirm the node was added. Retry won't add it twice.",
  limit: 'This study holds the most nodes it can (2,000), so the node was not added.',
  reference: "That passage isn't available in an active translation.",
  archived: 'This study is archived, so nodes can’t be added.',
  trashed: 'This study is in the trash, so nodes can’t be added.',
  notFound: "This study isn't available.",
  failed: "Couldn't add the node.",
} as const;

/** The outcome of an add, in words, by the passage's label. */
export function outcomeText(node: CreateNodeResponse, label: string): string {
  switch (node.outcome) {
    case 'created':
      return NODE_ADD_COPY.created(label);
    case 'focused_existing':
      return NODE_ADD_COPY.focused(label);
    case 'explicit_duplicate':
      return NODE_ADD_COPY.duplicate(label);
  }
}

/**
 * Why an add failed. `unknown`: the outcome is not known (network, 5xx, 429, a retryable
 * refusal), so the frozen request is kept for Retry. Everything else is definite: nothing was
 * added, and a new attempt is a new request.
 */
export type AddProblem =
  | { kind: 'unknown' }
  | { kind: 'unauthenticated' }
  | { kind: 'conflict' }
  | { kind: 'notFound' }
  | { kind: 'reference' }
  | { kind: 'limit' }
  | { kind: 'archived' }
  | { kind: 'trashed' }
  | { kind: 'invalid'; fields: string[] }
  | { kind: 'failed' };

export function addProblemOf(error: unknown): AddProblem {
  const kind = classifyError(error);
  if (isRetryable(kind) || !(error instanceof ApiError)) return { kind: 'unknown' };
  if (kind.kind === 'unauthenticated') return { kind: 'unauthenticated' };
  if (error.status === 409) return { kind: 'conflict' };
  if (error.status === 404) return { kind: 'notFound' };
  if (error.code === REFERENCE_NOT_FOUND) return { kind: 'reference' };
  if (error.code === NODE_LIMIT_EXCEEDED) return { kind: 'limit' };
  if (error.code === STUDY_ARCHIVED) return { kind: 'archived' };
  if (error.code === STUDY_TRASHED) return { kind: 'trashed' };
  if (error.status === 400) {
    const body = error.body as { fieldErrors?: Record<string, string[]> } | undefined;
    return { kind: 'invalid', fields: Object.keys(body?.fieldErrors ?? {}) };
  }
  return { kind: 'failed' };
}

/** A refused study lifecycle: the caller turns read-only rather than offering another try. */
export const isLifecycleRefusal = (problem: AddProblem): boolean =>
  problem.kind === 'archived' || problem.kind === 'trashed';

/**
 * The fixed text for a problem; `action` names the button a conflict asks to press again. An
 * unauthenticated failure has none here: `ProblemAlert` handles the session.
 */
export function addProblemText(problem: AddProblem, action: string): string {
  switch (problem.kind) {
    case 'unknown':
      return NODE_ADD_COPY.unknown;
    case 'conflict':
      return NODE_ADD_COPY.conflict(action);
    case 'notFound':
      return NODE_ADD_COPY.notFound;
    case 'reference':
      return NODE_ADD_COPY.reference;
    case 'limit':
      return NODE_ADD_COPY.limit;
    case 'archived':
      return NODE_ADD_COPY.archived;
    case 'trashed':
      return NODE_ADD_COPY.trashed;
    case 'unauthenticated':
    case 'invalid':
    case 'failed':
      return NODE_ADD_COPY.failed;
  }
}

/** The body of an Add for a Scripture node; `expectedRevision` is the study's. */
export function scriptureRequest(
  referenceId: string,
  expectedRevision: number,
  duplicatePolicy?: DuplicatePolicy,
): CreateNodeRequest {
  return {
    type: 'scripture',
    referenceId,
    expectedRevision,
    ...(duplicatePolicy ? { duplicatePolicy } : {}),
  };
}

export type AddResult<M> =
  | { ok: true; node: CreateNodeResponse; meta: M }
  | { ok: false; error: unknown; problem: AddProblem; meta: M };

interface Frozen<M> {
  json: string;
  key: string;
  body: CreateNodeRequest;
  meta: M;
}

/**
 * One add request's lifecycle (PRD section 24 idempotency). `send` is a deliberate new action:
 * it freezes that exact body (expectedRevision included) with a new Idempotency-Key, unless the
 * same body is still awaiting its outcome. `retry` resends the frozen request verbatim after an
 * unknown outcome, whatever has changed since (the study's revision included), so the server
 * replays its receipt instead of adding twice. A known outcome (success or a definite refusal)
 * clears the frozen request. `meta` travels with the request (e.g. the passage label it names).
 * Both return null while a request is in flight (or `retry` with nothing frozen).
 */
export function useAddNode<M = null>(studyId: string) {
  const frozen = useRef<Frozen<M> | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  async function run(attempt: Frozen<M>): Promise<AddResult<M>> {
    inFlight.current = true;
    setPending(true);
    try {
      const node = await createNode(studyId, attempt.body, attempt.key);
      frozen.current = null;
      return { ok: true, node, meta: attempt.meta };
    } catch (error) {
      const problem = addProblemOf(error);
      if (problem.kind !== 'unknown') frozen.current = null;
      return { ok: false, error, problem, meta: attempt.meta };
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    send(body: CreateNodeRequest, meta: M): Promise<AddResult<M>> | null {
      if (inFlight.current) return null;
      const json = JSON.stringify(body);
      const attempt =
        frozen.current?.json === json
          ? frozen.current
          : { json, key: crypto.randomUUID(), body, meta };
      frozen.current = attempt;
      return run(attempt);
    },
    retry(): Promise<AddResult<M>> | null {
      if (inFlight.current || frozen.current === null) return null;
      return run(frozen.current);
    },
  };
}
