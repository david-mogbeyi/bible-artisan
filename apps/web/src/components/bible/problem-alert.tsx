'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { classifyError, isRetryable, REFERENCE_ERROR_COPY } from '@/lib/api-errors';
import { ME_QUERY_KEY } from '@/lib/auth';

/** What this context calls its failures; every string is fixed copy, never a server message. */
export interface ProblemCopy {
  /** 404. */
  notFound: string;
  /** A refusal retrying cannot fix. */
  refused: string;
  /** 503, a server or network failure. */
  unavailable: string;
}

const SESSION_ENDED = 'Your session has ended. Taking you to sign in…';
const RATE_LIMITED = 'Too many requests right now.';

/**
 * A failed request, said in fixed copy chosen from the status and code (PRD section 24):
 * - 401: the session is re-checked, so `RequireAuth` sends the user to sign in and back here
 *   (its `next` is the current path, read back through `safeNext`);
 * - 429/503 and other retryable failures: Retry, held until `Retry-After` has passed when the
 *   server sent one (the button stays focusable, with the wait said in text);
 * - 404, a reference error, or another refusal: no Retry, and nothing substituted.
 */
export function ProblemAlert({
  error,
  copy,
  onRetry,
}: {
  error: unknown;
  copy: ProblemCopy;
  /** Omit when the action cannot be repeated from here. */
  onRetry?: () => void;
}) {
  const queryClient = useQueryClient();
  const kind = classifyError(error);
  const wait =
    kind.kind === 'rate_limited' || kind.kind === 'unavailable'
      ? kind.retryAfterSeconds
      : undefined;
  const [waitedFor, setWaitedFor] = useState<unknown>(null);
  const waiting = wait !== undefined && waitedFor !== error;

  useEffect(() => {
    if (kind.kind !== 'unauthenticated') return;
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [kind.kind, queryClient]);

  useEffect(() => {
    if (wait === undefined) return;
    const timer = setTimeout(() => setWaitedFor(error), wait * 1000);
    return () => clearTimeout(timer);
  }, [error, wait]);

  const message =
    kind.kind === 'unauthenticated'
      ? SESSION_ENDED
      : kind.kind === 'not_found'
        ? copy.notFound
        : kind.kind === 'reference'
          ? REFERENCE_ERROR_COPY[kind.code]
          : kind.kind === 'rate_limited'
            ? RATE_LIMITED
            : kind.kind === 'unavailable'
              ? copy.unavailable
              : copy.refused;
  const retry = isRetryable(kind) && onRetry;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded border border-accent px-3 py-2"
    >
      <p>
        {message}
        {retry && waiting ? ` You can retry in ${wait} ${wait === 1 ? 'second' : 'seconds'}.` : ''}
      </p>
      {retry ? (
        <button
          type="button"
          aria-disabled={waiting ? true : undefined}
          onClick={() => {
            if (!waiting) onRetry();
          }}
          className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
