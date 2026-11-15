'use client';

import {
  AI_SUGGESTION_EXPIRED,
  type AiSuggestion,
  EDGE_TYPE_NAMES,
  EDGE_TYPES,
  type EdgeType,
  type NodeSummary,
} from '@bible-artisan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  acceptAiSuggestion,
  aiSuggestionsQueryKey,
  fetchAiJob,
  listAiSuggestions,
  rejectAiSuggestion,
  requestRelationships,
} from '@/lib/ai';
import { ApiError } from '@/lib/api-client';
import { edgeSentence, invalidateEdgeChange } from '@/lib/edges';
import { nodeOptionText } from '@/lib/nodes';
import { invalidateThread } from '@/lib/thread';

export const SUGGESTIONS_COPY = {
  open: 'Suggest relationships with AI',
  close: 'Hide AI suggestions',
  heading: 'AI suggestions',
  intro:
    'AI can suggest how this node may relate to another one. Nothing is added until you accept a suggestion.',
  pickLabel: 'Suggest a relationship with',
  request: 'Suggest relationship',
  again: 'Suggest again, including dismissed ones',
  asking: 'Asking AI for suggestions…',
  none: 'AI found no clear relationship between these two nodes.',
  failed: "AI couldn't suggest anything this time. Your study is unchanged. Try again later.",
  consent: 'Turn on AI features in Settings to get suggestions.',
  disabledForStudy: 'AI features are turned off for this study.',
  unavailable: 'AI suggestions are not available right now. Every study feature still works.',
  limited: 'You have reached the AI request limit. Try again later.',
  badge: 'AI suggested',
  why: 'Why: ',
  evidence: 'Evidence',
  expired: 'Expired: a node it connects changed after it was suggested.',
  accept: 'Accept',
  edit: 'Edit',
  acceptEdited: 'Accept with this type',
  cancelEdit: 'Cancel edit',
  typeLabel: 'Relationship type',
  reject: 'Dismiss',
  accepted: 'Relationship added from the AI suggestion.',
  rejected: 'Suggestion dismissed.',
  changed: 'This suggestion changed. Review it again.',
  decisionFailed: "Couldn't save your decision. Try again.",
} as const;

type JobView = 'asking' | 'none' | 'failed' | null;

/**
 * AI relationship proposals for one node (BIB-42; PRD sections 12, 16; FR-AI-002): the user picks
 * another node and asks; each proposal shows an "AI suggested" label, the relationship in words,
 * the rationale and its evidence, with Accept, Edit (choose another type, then accept) and
 * Dismiss. Nothing reaches the graph without Accept. Collapsed until opened, so no AI request or
 * read happens on its own.
 */
export function RelationshipSuggestions({
  studyId,
  node,
  nodes,
}: {
  studyId: string;
  node: { id: string };
  nodes: NodeSummary[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="self-start rounded border border-muted px-3 py-1"
      >
        {open ? SUGGESTIONS_COPY.close : SUGGESTIONS_COPY.open}
      </button>
      {open ? <SuggestionsPanel id={panelId} studyId={studyId} node={node} nodes={nodes} /> : null}
    </div>
  );
}

function SuggestionsPanel({
  id,
  studyId,
  node,
  nodes,
}: {
  id: string;
  studyId: string;
  node: { id: string };
  nodes: NodeSummary[];
}) {
  const headingId = useId();
  const pickId = useId();
  const queryClient = useQueryClient();
  const others = nodes.filter((candidate) => candidate.id !== node.id);
  const [otherId, setOtherId] = useState(others[0]?.id ?? '');
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const suggestions = useQuery({
    queryKey: aiSuggestionsQueryKey(studyId, node.id),
    queryFn: () => listAiSuggestions(studyId, node.id),
  });
  const job = useQuery({
    queryKey: ['studies', studyId, 'ai-job', jobId],
    queryFn: () => fetchAiJob(studyId, jobId ?? ''),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'succeeded' || state === 'failed' || state === 'cancelled' ? false : 2000;
    },
  });
  const jobState = job.data?.state;
  const finished = jobState === 'succeeded' || jobState === 'failed' || jobState === 'cancelled';
  useEffect(() => {
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: aiSuggestionsQueryKey(studyId, node.id) });
    }
  }, [finished, queryClient, studyId, node.id]);

  const ask = useMutation({
    mutationFn: (regenerate: boolean) =>
      requestRelationships(
        studyId,
        { sourceNodeId: node.id, targetNodeId: otherId, ...(regenerate ? { regenerate } : {}) },
        crypto.randomUUID(),
      ),
    onMutate: () => {
      setProblem(null);
      setAnnouncement('');
    },
    onSuccess: (accepted) => setJobId(accepted.jobId),
    onError: (error) => setProblem(requestProblem(error)),
  });

  let view: JobView = null;
  if (ask.isPending || (jobId !== null && !finished)) view = 'asking';
  else if (jobState === 'failed' || jobState === 'cancelled') view = 'failed';
  else if (
    jobState === 'succeeded' &&
    job.data?.result?.output &&
    'suggestionIds' in job.data.result.output &&
    job.data.result.output.suggestionIds.length === 0
  ) {
    view = 'none';
  }

  const labelOf = (nodeId: string): string => {
    const found = nodes.find((candidate) => candidate.id === nodeId);
    return found ? nodeOptionText(found) : 'another node in this study';
  };

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded border border-dashed border-muted p-3"
    >
      <h5 id={headingId} className="font-medium">
        {SUGGESTIONS_COPY.heading}
      </h5>
      <p className="text-sm text-muted">{SUGGESTIONS_COPY.intro}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {others.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={pickId} className="flex flex-col gap-1 text-sm">
            {SUGGESTIONS_COPY.pickLabel}
            <select
              id={pickId}
              value={otherId}
              onChange={(event) => setOtherId(event.target.value)}
              className="rounded border border-muted px-2 py-1"
            >
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {nodeOptionText(other)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={view === 'asking' || otherId === ''}
            onClick={() => ask.mutate(false)}
            className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
          >
            {SUGGESTIONS_COPY.request}
          </button>
          <button
            type="button"
            disabled={view === 'asking' || otherId === ''}
            onClick={() => ask.mutate(true)}
            className="underline disabled:opacity-60"
          >
            {SUGGESTIONS_COPY.again}
          </button>
        </div>
      ) : null}
      {view === 'asking' ? <p role="status">{SUGGESTIONS_COPY.asking}</p> : null}
      {view === 'none' ? <p role="status">{SUGGESTIONS_COPY.none}</p> : null}
      {view === 'failed' ? <p role="alert">{SUGGESTIONS_COPY.failed}</p> : null}
      {problem ? (
        <p role="alert">
          {problem}{' '}
          {problem === SUGGESTIONS_COPY.consent ? (
            <Link href="/settings" className="underline">
              Open Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      {suggestions.data && suggestions.data.items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {suggestions.data.items.map((suggestion) => (
            <SuggestionItem
              key={suggestion.id}
              studyId={studyId}
              nodeId={node.id}
              suggestion={suggestion}
              labelOf={labelOf}
              onDecided={(message) => setAnnouncement(message)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SuggestionItem({
  studyId,
  nodeId,
  suggestion,
  labelOf,
  onDecided,
}: {
  studyId: string;
  nodeId: string;
  suggestion: AiSuggestion;
  labelOf: (nodeId: string) => string;
  onDecided: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const typeId = useId();
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<EdgeType>(suggestion.type);
  const [problem, setProblem] = useState<string | null>(null);
  // One key per decision, reused by its retries (same body).
  const attempt = useRef<{ json: string; key: string } | null>(null);
  const keyFor = (json: string) => {
    if (attempt.current?.json !== json) attempt.current = { json, key: crypto.randomUUID() };
    return attempt.current.key;
  };
  const refreshSuggestions = () =>
    queryClient.invalidateQueries({ queryKey: aiSuggestionsQueryKey(studyId, nodeId) });

  const onError = (error: unknown) => {
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.code === AI_SUGGESTION_EXPIRED)
    ) {
      setProblem(SUGGESTIONS_COPY.changed);
      void refreshSuggestions();
      return;
    }
    setProblem(SUGGESTIONS_COPY.decisionFailed);
  };

  const accept = useMutation({
    mutationFn: (chosen: EdgeType) => {
      const body = {
        expectedRevision: suggestion.revision,
        ...(chosen !== suggestion.type ? { type: chosen } : {}),
      };
      const json = JSON.stringify(['accept', body]);
      return acceptAiSuggestion(studyId, suggestion.id, body, keyFor(json));
    },
    onSuccess: async (accepted) => {
      onDecided(SUGGESTIONS_COPY.accepted);
      await Promise.all([
        refreshSuggestions(),
        invalidateEdgeChange(queryClient, studyId, accepted.edge),
      ]);
    },
    onError,
  });
  const reject = useMutation({
    mutationFn: () => {
      const body = { expectedRevision: suggestion.revision };
      return rejectAiSuggestion(
        studyId,
        suggestion.id,
        body,
        keyFor(JSON.stringify(['reject', body])),
      );
    },
    onSuccess: async () => {
      onDecided(SUGGESTIONS_COPY.rejected);
      // The rejection recorded a Study Thread event.
      await Promise.all([refreshSuggestions(), invalidateThread(queryClient, studyId)]);
    },
    onError,
  });

  const expired = suggestion.status === 'expired';
  const busy = accept.isPending || reject.isPending;
  const sentence = edgeSentence(
    labelOf(suggestion.sourceNodeId),
    suggestion.type,
    labelOf(suggestion.targetNodeId),
  );

  return (
    <li className="flex flex-col gap-2 rounded border border-dashed border-accent p-3">
      <p>
        <span className="mr-2 rounded bg-muted/20 px-1 text-sm font-medium">
          {SUGGESTIONS_COPY.badge}
        </span>{' '}
        {sentence}
      </p>
      <p className="text-sm text-muted">{EDGE_TYPE_NAMES[suggestion.type]}</p>
      <p className="break-words">
        <span className="font-medium">{SUGGESTIONS_COPY.why}</span>
        {suggestion.rationale}
      </p>
      <div>
        <p className="text-sm font-medium">{SUGGESTIONS_COPY.evidence}</p>
        <ul className="list-disc pl-5 text-sm">
          {suggestion.evidence.map((item, index) => (
            <li key={`${item.id}-${index}`} className="break-words">
              {labelOf(item.id)}
              {item.quote ? <> — “{item.quote}”</> : null}
            </li>
          ))}
        </ul>
      </div>
      {expired ? <p className="text-sm">{SUGGESTIONS_COPY.expired}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {editing && !expired ? (
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={typeId} className="flex flex-col gap-1 text-sm">
            {SUGGESTIONS_COPY.typeLabel}
            <select
              id={typeId}
              value={type}
              onChange={(event) => setType(event.target.value as EdgeType)}
              className="rounded border border-muted px-2 py-1"
            >
              {EDGE_TYPES.map((option) => (
                <option key={option} value={option}>
                  {EDGE_TYPE_NAMES[option]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => accept.mutate(type)}
            className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
          >
            {SUGGESTIONS_COPY.acceptEdited}
          </button>
          <button type="button" onClick={() => setEditing(false)} className="underline">
            {SUGGESTIONS_COPY.cancelEdit}
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {!expired && !editing ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => accept.mutate(suggestion.type)}
              className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
            >
              {SUGGESTIONS_COPY.accept} <span className="sr-only">{sentence}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className="underline disabled:opacity-60"
            >
              {SUGGESTIONS_COPY.edit} <span className="sr-only">{sentence}</span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => reject.mutate()}
          className="underline disabled:opacity-60"
        >
          {SUGGESTIONS_COPY.reject} <span className="sr-only">{sentence}</span>
        </button>
      </div>
    </li>
  );
}

function requestProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_CONSENT_REQUIRED' || error.code === 'AI_CONSENT_VERSION_MISMATCH') {
      return SUGGESTIONS_COPY.consent;
    }
    if (error.code === 'AI_DISABLED_FOR_STUDY') return SUGGESTIONS_COPY.disabledForStudy;
    if (error.status === 429) return SUGGESTIONS_COPY.limited;
  }
  return SUGGESTIONS_COPY.unavailable;
}
