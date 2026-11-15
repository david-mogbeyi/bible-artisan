'use client';

import { NODE_TYPE_NAMES, type NodeSummary } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { listNodes, nodesQueryKey } from '@/lib/nodes';

export const MENTION_COPY = {
  button: 'Mention node…',
  loading: 'Loading the study’s nodes…',
  failed: "Couldn't load the study's nodes. Try again.",
  empty: 'This study has no nodes to mention yet.',
  choose: 'Choose a node to mention.',
  inserted: 'Mention added.',
} as const;

/**
 * "Mention node…" (BIB-58): picks a live node of the study from the node list (the same labels
 * the Nodes section shows) and hands its id and label to the editor, which inserts a mention.
 * Nothing is sent to the server here; the note's next save carries the mention and the server
 * checks it.
 */
export function MentionNodeForm({
  studyId,
  onInsert,
  onCancel,
}: {
  studyId: string;
  onInsert: (node: Pick<NodeSummary, 'id' | 'label'>) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const nodes = useQuery({
    queryKey: nodesQueryKey(studyId),
    queryFn: () => listNodes(studyId),
  });
  const [choice, setChoice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const select = useRef<HTMLSelectElement>(null);
  const items = nodes.data?.items ?? [];

  useEffect(() => {
    select.current?.focus();
  }, [nodes.data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const node = items.find((item) => item.id === choice);
    if (!node) {
      setProblem(MENTION_COPY.choose);
      return;
    }
    onInsert({ id: node.id, label: node.label });
  }

  return (
    <form
      aria-label="Mention a node"
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      className="flex flex-col gap-2 rounded border border-muted p-3 sm:flex-row sm:flex-wrap sm:items-end"
    >
      {nodes.isPending ? (
        <p role="status">{MENTION_COPY.loading}</p>
      ) : nodes.isError ? (
        <p role="alert">{MENTION_COPY.failed}</p>
      ) : items.length === 0 ? (
        <p>{MENTION_COPY.empty}</p>
      ) : (
        <label htmlFor={id} className="flex flex-col text-sm">
          Node
          <select
            id={id}
            ref={select}
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            className="max-w-full rounded border border-muted bg-canvas px-2 py-1"
          >
            <option value="">Choose a node</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {`${NODE_TYPE_NAMES[item.type]}: ${item.label}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="rounded border border-muted px-2 py-1 text-sm">
        Insert mention
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-muted px-2 py-1 text-sm"
      >
        Cancel
      </button>
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="w-full text-sm font-medium text-accent">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
