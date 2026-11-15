'use client';

import {
  type CreateNodeRequest,
  createNodeRequestSchema,
  MAX_NODE_TEXT_LENGTH,
  NODE_TYPE_NAMES,
  NOTE_TRASHED,
  OBSERVATION_KIND_NAMES,
  OBSERVATION_KINDS,
  type ObservationKind,
} from '@bible-artisan/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { isLifecycleRefusal, NODE_ADD_COPY, useAddNode } from '@/lib/add-node';
import { ApiError } from '@/lib/api-client';
import { invalidateGraph } from '@/lib/graph';
import { nodesQueryKey } from '@/lib/nodes';
import { studyQueryKey } from '@/lib/studies';
import { TextAreaField } from '../nodes/node-fields';

type ConvertType = 'observation' | 'thought';

/** Fixed copy for converting a note excerpt (BIB-57): never the excerpt or the note's text. */
export const MAKE_NODE_COPY = {
  button: 'Make node…',
  noSelection: 'Select some text in the note first.',
  unsaved: 'Wait until the note is saved, then choose Make node again.',
  created: (type: ConvertType) =>
    `Created ${type === 'observation' ? 'an Observation' : 'a Thought'} from this note.`,
  conflict:
    'This study changed somewhere else, so the node was not created. Reload, then try again.',
  noteTrashed: 'This note is in the trash, so no node was made from it. Restore it first.',
  notFound: "This note isn't available any more. Reload the study.",
  empty: 'Add some text for the node.',
  tooLong: `A node can hold at most ${MAX_NODE_TEXT_LENGTH.toLocaleString('en-US')} characters. Shorten the text first.`,
} as const;

/**
 * "Make node…" (BIB-57; PRD sections 8, 15): an Observation or a Thought from text selected in a
 * note, prefilled with that text and editable, remembering the note as its provenance. The note
 * itself is not changed. The request is the ordinary node create (study `expectedRevision`,
 * frozen with its Idempotency-Key so Retry after an unknown outcome cannot create it twice).
 */
export function MakeNodeForm({
  studyId,
  studyRevision,
  noteId,
  initialText,
  onCreated,
  onCancel,
  onReload,
}: {
  studyId: string;
  studyRevision: number;
  noteId: string;
  initialText: string;
  onCreated: (message: string) => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [type, setType] = useState<ConvertType>('observation');
  const [observationKind, setObservationKind] = useState<ObservationKind>('textual_observation');
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | undefined>();
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const add = useAddNode(studyId);
  const firstType = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstType.current?.focus();
  }, []);

  function requestOf(): CreateNodeRequest | null {
    const body: CreateNodeRequest =
      type === 'observation'
        ? {
            type,
            expectedRevision: studyRevision,
            text,
            observationKind,
            derivedFromNoteId: noteId,
          }
        : { type, expectedRevision: studyRevision, text, derivedFromNoteId: noteId };
    if (!createNodeRequestSchema.safeParse(body).success) {
      setError(
        [...text.trim()].length > MAX_NODE_TEXT_LENGTH
          ? MAKE_NODE_COPY.tooLong
          : MAKE_NODE_COPY.empty,
      );
      return null;
    }
    setError(undefined);
    return body;
  }

  async function submit(retry = false) {
    let request: ReturnType<typeof add.send>;
    if (retry) {
      request = add.retry();
    } else {
      const body = requestOf();
      if (!body) return;
      request = add.send(body, null);
    }
    if (!request) return;
    setProblem(null);
    const result = await request;
    if (result.ok) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) }),
        queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId) }),
        invalidateGraph(queryClient, studyId),
      ]);
      onCreated(MAKE_NODE_COPY.created(type));
      return;
    }
    const reason = result.problem;
    if (reason.kind === 'conflict') {
      onReload();
      setProblem({ text: MAKE_NODE_COPY.conflict, retry: false });
    } else if (result.error instanceof ApiError && result.error.code === NOTE_TRASHED) {
      setProblem({ text: MAKE_NODE_COPY.noteTrashed, retry: false });
    } else if (reason.kind === 'notFound') {
      setProblem({ text: MAKE_NODE_COPY.notFound, retry: false });
    } else if (isLifecycleRefusal(reason)) {
      onReload();
      setProblem({
        text: reason.kind === 'archived' ? NODE_ADD_COPY.archived : NODE_ADD_COPY.trashed,
        retry: false,
      });
    } else if (reason.kind === 'limit') {
      setProblem({ text: NODE_ADD_COPY.limit, retry: false });
    } else if (reason.kind === 'unknown') {
      setProblem({
        text: "Couldn't confirm the node was created. Retry won't create it twice.",
        retry: true,
      });
    } else {
      setProblem({ text: "Couldn't create the node.", retry: false });
    }
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3 rounded border border-muted p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <h3 id={`${id}-heading`} className="font-medium">
        Make a node from the selected text
      </h3>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Type</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            {(['observation', 'thought'] as const).map((option) => (
              <label key={option} className="flex items-center gap-2">
                <input
                  ref={option === 'observation' ? firstType : undefined}
                  type="radio"
                  name={`${id}-type`}
                  value={option}
                  checked={type === option}
                  onChange={() => setType(option)}
                />
                {NODE_TYPE_NAMES[option]}
              </label>
            ))}
          </div>
        </fieldset>
        {type === 'observation' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Kind</legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              {OBSERVATION_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-kind`}
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
        <TextAreaField
          label="Node text"
          value={text}
          onChange={setText}
          max={MAX_NODE_TEXT_LENGTH}
          error={error}
        />
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
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            type="submit"
            aria-disabled={add.pending ? true : undefined}
            onClick={(event) => {
              if (add.pending) event.preventDefault();
            }}
            className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
          >
            {add.pending ? 'Creating…' : 'Create node'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-muted px-3 py-1"
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
