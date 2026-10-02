'use client';

import {
  DEFAULT_EDGE_TYPES,
  EDGE_TYPE_HELP,
  EDGE_TYPE_NAMES,
  EDGE_TYPES,
  type EdgeType,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { type Ref, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { classifyError, isRetryable } from '@/lib/api-errors';

/**
 * The pieces node detail's relationship edits (BIB-27) and the Connect dialog (BIB-29) share: the
 * relationship picker, the frozen-request lifecycle, and the error helpers.
 */

/** The server's relationship rules, said next to "Relationship". */
export const EDGE_RULE_COPY = {
  targetNotQuestion: 'This relationship must point to a question.',
  exists: 'These nodes already have a relationship of that type.',
} as const;

const MORE_EDGE_TYPES = EDGE_TYPES.filter(
  (type) => !(DEFAULT_EDGE_TYPES as readonly EdgeType[]).includes(type),
);

export type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown; unknown: boolean };

/**
 * One mutation's request lifecycle (PRD section 24 idempotency), as `useAddNode` does for nodes:
 * `send` freezes that exact body with a new Idempotency-Key (unless the same body still awaits its
 * outcome); `retry` resends the frozen request verbatim after an unknown outcome (network, 5xx,
 * 429, a retryable refusal); a known outcome clears it. Both return null while one is in flight.
 */
export function useFrozenRequest<B, R>(run: (body: B, key: string) => Promise<R>) {
  const frozen = useRef<{ json: string; key: string; body: B } | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  async function go(attempt: { json: string; key: string; body: B }): Promise<Outcome<R>> {
    inFlight.current = true;
    setPending(true);
    try {
      const value = await run(attempt.body, attempt.key);
      frozen.current = null;
      return { ok: true, value };
    } catch (error) {
      const unknown = !(error instanceof ApiError) || isRetryable(classifyError(error));
      if (!unknown) frozen.current = null;
      return { ok: false, error, unknown };
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    send(body: B): Promise<Outcome<R>> | null {
      if (inFlight.current) return null;
      const json = JSON.stringify(body);
      const attempt =
        frozen.current?.json === json ? frozen.current : { json, key: crypto.randomUUID(), body };
      frozen.current = attempt;
      return go(attempt);
    },
    retry(): Promise<Outcome<R>> | null {
      if (inFlight.current || frozen.current === null) return null;
      return go(frozen.current);
    },
  };
}

export const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
export const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
export const isLifecycle = (error: unknown) =>
  codeOf(error) === STUDY_ARCHIVED || codeOf(error) === STUDY_TRASHED;

export interface Problem {
  text: string;
  retry?: boolean;
  reload?: boolean;
}

function TypeOptions({ types }: { types: readonly EdgeType[] }) {
  return types.map((type) => (
    <option key={type} value={type}>
      {EDGE_TYPE_NAMES[type]}
    </option>
  ));
}

/**
 * The relationship picker: an optional placeholder (nothing chosen yet), the default types, then
 * "More relationships", with the chosen type's helper copy.
 */
export function TypeSelect({
  value,
  onChange,
  types,
  placeholder,
  error,
  selectRef,
}: {
  value: EdgeType | '';
  onChange: (type: EdgeType | '') => void;
  /** Only these (an edit offers its own direction class); all 15 when omitted. */
  types?: readonly EdgeType[];
  placeholder?: string;
  error?: string;
  selectRef?: Ref<HTMLSelectElement>;
}) {
  const id = useId();
  const help = value ? EDGE_TYPE_HELP[value] : undefined;
  const described = [help ? `${id}-help` : '', error ? `${id}-error` : ''].join(' ').trim();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        Relationship
      </label>
      <select
        id={id}
        ref={selectRef}
        value={value}
        onChange={(event) => onChange(event.target.value as EdgeType | '')}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        className="w-full rounded border border-muted bg-canvas px-2 py-1"
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {types ? (
          <TypeOptions types={types} />
        ) : (
          <>
            <TypeOptions types={DEFAULT_EDGE_TYPES} />
            <optgroup label="More relationships">
              <TypeOptions types={MORE_EDGE_TYPES} />
            </optgroup>
          </>
        )}
      </select>
      {help ? (
        <p id={`${id}-help`} className="text-sm text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ProblemLine({
  problem,
  onRetry,
  onReload,
}: {
  problem: Problem;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p>{problem.text}</p>
      {problem.retry && onRetry ? (
        <button type="button" onClick={onRetry} className="underline">
          Retry
        </button>
      ) : null}
      {problem.reload && onReload ? (
        <button type="button" onClick={onReload} className="underline">
          Reload
        </button>
      ) : null}
    </div>
  );
}
