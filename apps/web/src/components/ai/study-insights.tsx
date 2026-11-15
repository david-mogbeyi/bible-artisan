'use client';

import type { AiProposal, AiSuggestion, NodeSummary } from '@bible-artisan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  acceptAiSuggestion,
  acceptProposal,
  fetchAiJob,
  type InsightCapability,
  insightQueryKey,
  listProposals,
  listTensions,
  rejectAiSuggestion,
  rejectProposal,
  requestInsight,
} from '@/lib/ai';
import { ApiError } from '@/lib/api-client';
import { bibleHref } from '@/lib/bible';
import { edgeSentence, invalidateEdgeChange } from '@/lib/edges';
import { invalidateNodeChange, listNodes, nodeOptionText, nodesQueryKey } from '@/lib/nodes';
import { invalidateThread } from '@/lib/thread';

export const INSIGHTS_COPY = {
  open: 'Show AI suggestions for this study',
  close: 'Hide AI suggestions for this study',
  heading: 'AI suggestions for this study',
  intro:
    'AI can point out possible tensions, unanswered questions and passages to read next. Nothing changes in your study until you accept a suggestion, and AI never changes a status.',
  badge: 'AI suggested',
  tensions: 'Tensions',
  checkTensions: 'Check for tensions',
  questions: 'Unanswered questions',
  findQuestions: 'Find unanswered questions',
  passages: 'Passages to investigate next',
  findPassages: 'What could I investigate next?',
  asking: 'Asking AI…',
  noneTensions: 'AI found no clear tension.',
  noneQuestions: 'AI proposed no new questions.',
  nonePassages: 'No verified passage to suggest right now.',
  stillOpen: 'Still open in your study: ',
  failed: "AI couldn't help this time. Your study is unchanged. Try again later.",
  consent: 'Turn on AI features in Settings to get suggestions.',
  disabledForStudy: 'AI features are turned off for this study.',
  unavailable: 'AI suggestions are not available right now. Every study feature still works.',
  limited: 'You have reached the AI request limit. Try again later.',
  caveat: 'Caveat: ',
  why: 'Why: ',
  addRelationship: 'Add this relationship',
  addQuestion: 'Add as a question',
  addPassage: 'Add to study',
  openPassage: 'Open in reader',
  dismiss: 'Dismiss',
  expired: 'Expired: something it rests on changed after it was suggested.',
  decided: 'Saved.',
  changed: 'This suggestion changed. Review it again.',
  decisionFailed: "Couldn't save your decision. Try again.",
} as const;

/**
 * Study-wide AI suggestions (BIB-44 tensions and open questions, BIB-45 passages; PRD section
 * 16). Collapsed until opened, so no AI request or read happens on its own. Each suggestion is
 * labelled "AI suggested" in text and changes nothing until the user adds it; adding a tension
 * adds the qualifying or contradicting relationship and never a status.
 */
export function StudyInsights({ studyId, active }: { studyId: string; active: boolean }) {
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
        {open ? INSIGHTS_COPY.close : INSIGHTS_COPY.open}
      </button>
      {open ? <InsightsPanel id={panelId} studyId={studyId} active={active} /> : null}
    </div>
  );
}

function InsightsPanel({ id, studyId, active }: { id: string; studyId: string; active: boolean }) {
  const headingId = useId();
  const nodes = useQuery({ queryKey: nodesQueryKey(studyId), queryFn: () => listNodes(studyId) });
  const labelOf = (nodeId: string): string => {
    const found = nodes.data?.items.find((node: NodeSummary) => node.id === nodeId);
    return found ? nodeOptionText(found) : 'another item in this study';
  };
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded border border-dashed border-muted p-3"
    >
      <h3 id={headingId} className="font-medium">
        {INSIGHTS_COPY.heading}
      </h3>
      <p className="text-sm text-muted">{INSIGHTS_COPY.intro}</p>
      <InsightSection studyId={studyId} active={active} capability="tensions" labelOf={labelOf} />
      <InsightSection studyId={studyId} active={active} capability="questions" labelOf={labelOf} />
      <InsightSection studyId={studyId} active={active} capability="passages" labelOf={labelOf} />
    </section>
  );
}

const SECTION_COPY: Record<InsightCapability, { title: string; ask: string; none: string }> = {
  tensions: {
    title: INSIGHTS_COPY.tensions,
    ask: INSIGHTS_COPY.checkTensions,
    none: INSIGHTS_COPY.noneTensions,
  },
  questions: {
    title: INSIGHTS_COPY.questions,
    ask: INSIGHTS_COPY.findQuestions,
    none: INSIGHTS_COPY.noneQuestions,
  },
  passages: {
    title: INSIGHTS_COPY.passages,
    ask: INSIGHTS_COPY.findPassages,
    none: INSIGHTS_COPY.nonePassages,
  },
};

type Item = { kind: 'tension'; tension: AiSuggestion } | { kind: 'proposal'; proposal: AiProposal };

function InsightSection({
  studyId,
  active,
  capability,
  labelOf,
}: {
  studyId: string;
  active: boolean;
  capability: InsightCapability;
  labelOf: (nodeId: string) => string;
}) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const copy = SECTION_COPY[capability];
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const list = useQuery({
    queryKey: insightQueryKey(studyId, capability),
    queryFn: async (): Promise<Item[]> =>
      capability === 'tensions'
        ? (await listTensions(studyId)).items.map((tension) => ({ kind: 'tension', tension }))
        : (await listProposals(studyId, capability)).items.map((proposal) => ({
            kind: 'proposal',
            proposal,
          })),
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
  const state = job.data?.state;
  const finished = state === 'succeeded' || state === 'failed' || state === 'cancelled';
  useEffect(() => {
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: insightQueryKey(studyId, capability) });
    }
  }, [finished, queryClient, studyId, capability]);

  const ask = useMutation({
    mutationFn: () => requestInsight(studyId, capability, {}, crypto.randomUUID()),
    onMutate: () => {
      setProblem(null);
      setAnnouncement('');
    },
    onSuccess: (accepted) => setJobId(accepted.jobId),
    onError: (error) => setProblem(requestProblem(error)),
  });

  const asking = ask.isPending || (jobId !== null && !finished);
  const output = job.data?.result?.output;
  const existingOpen =
    output && 'existingOpenQuestionIds' in output ? output.existingOpenQuestionIds : [];
  const items = list.data ?? [];
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="font-medium">
        {copy.title}
      </h4>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {active ? (
        <button
          type="button"
          disabled={asking}
          onClick={() => ask.mutate()}
          className="self-start rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
        >
          {copy.ask}
        </button>
      ) : null}
      {asking ? <p role="status">{INSIGHTS_COPY.asking}</p> : null}
      {state === 'failed' || state === 'cancelled' ? (
        <p role="alert">{INSIGHTS_COPY.failed}</p>
      ) : null}
      {problem ? (
        <p role="alert">
          {problem}{' '}
          {problem === INSIGHTS_COPY.consent ? (
            <Link href="/settings" className="underline">
              Open Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      {state === 'succeeded' && existingOpen.length > 0 ? (
        <p className="break-words text-sm">
          {INSIGHTS_COPY.stillOpen}
          {existingOpen.map(labelOf).join('; ')}
        </p>
      ) : null}
      {state === 'succeeded' && items.length === 0 ? <p role="status">{copy.none}</p> : null}
      {items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <InsightItem
              key={item.kind === 'tension' ? item.tension.id : item.proposal.id}
              studyId={studyId}
              item={item}
              active={active}
              labelOf={labelOf}
              onDecided={(message) => {
                setAnnouncement(message);
                void queryClient.invalidateQueries({
                  queryKey: insightQueryKey(studyId, capability),
                });
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function InsightItem({
  studyId,
  item,
  active,
  labelOf,
  onDecided,
}: {
  studyId: string;
  item: Item;
  active: boolean;
  labelOf: (nodeId: string) => string;
  onDecided: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = useRef<{ json: string; key: string } | null>(null);
  const keyFor = (json: string) => {
    if (attempt.current?.json !== json) attempt.current = { json, key: crypto.randomUUID() };
    return attempt.current.key;
  };
  const id = item.kind === 'tension' ? item.tension.id : item.proposal.id;
  const revision = item.kind === 'tension' ? item.tension.revision : item.proposal.revision;
  const status = item.kind === 'tension' ? item.tension.status : item.proposal.status;

  const onError = (error: unknown) => {
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.code === 'AI_SUGGESTION_EXPIRED')
    ) {
      setProblem(INSIGHTS_COPY.changed);
      onDecided('');
      return;
    }
    setProblem(INSIGHTS_COPY.decisionFailed);
  };

  const accept = useMutation({
    mutationFn: async () => {
      const body = { expectedRevision: revision };
      const key = keyFor(JSON.stringify(['accept', body]));
      if (item.kind === 'tension') {
        const accepted = await acceptAiSuggestion(studyId, id, body, key);
        await invalidateEdgeChange(queryClient, studyId, accepted.edge);
        return;
      }
      const accepted = await acceptProposal(studyId, id, body, key);
      await invalidateNodeChange(queryClient, studyId, accepted.node.id);
    },
    onSuccess: () => onDecided(INSIGHTS_COPY.decided),
    onError,
  });
  const reject = useMutation({
    mutationFn: async (): Promise<void> => {
      const body = { expectedRevision: revision };
      const key = keyFor(JSON.stringify(['reject', body]));
      if (item.kind === 'tension') await rejectAiSuggestion(studyId, id, body, key);
      else await rejectProposal(studyId, id, body, key);
      // The rejection recorded a Study Thread event.
      void invalidateThread(queryClient, studyId);
    },
    onSuccess: () => onDecided(INSIGHTS_COPY.decided),
    onError,
  });

  let title: string;
  let detail: string;
  let extra: string | null = null;
  let acceptLabel: string;
  if (item.kind === 'tension') {
    const { tension } = item;
    title = edgeSentence(
      labelOf(tension.sourceNodeId),
      tension.type,
      labelOf(tension.targetNodeId),
    );
    detail = tension.rationale;
    extra = tension.caveat;
    acceptLabel = INSIGHTS_COPY.addRelationship;
  } else if (item.proposal.capability === 'questions') {
    title = item.proposal.text;
    detail = item.proposal.rationale;
    acceptLabel = INSIGHTS_COPY.addQuestion;
  } else {
    title = item.proposal.reference.label;
    detail = item.proposal.reason;
    acceptLabel = INSIGHTS_COPY.addPassage;
  }
  const busy = accept.isPending || reject.isPending;
  const expired = status === 'expired';
  return (
    <li className="flex flex-col gap-1 rounded border border-dashed border-accent p-3">
      <p className="break-words">
        <span className="mr-2 rounded bg-muted/20 px-1 text-sm font-medium">
          {INSIGHTS_COPY.badge}
        </span>{' '}
        {title}
      </p>
      <p className="break-words text-sm">
        <span className="font-medium">{INSIGHTS_COPY.why}</span>
        {detail}
      </p>
      {extra ? (
        <p className="break-words text-sm">
          <span className="font-medium">{INSIGHTS_COPY.caveat}</span>
          {extra}
        </p>
      ) : null}
      {expired ? <p className="text-sm">{INSIGHTS_COPY.expired}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <div className="flex flex-wrap gap-3">
        {item.kind === 'proposal' && item.proposal.capability === 'passages' ? (
          <Link
            href={bibleHref(item.proposal.reference.referenceId, studyId)}
            className="text-accent underline"
          >
            {INSIGHTS_COPY.openPassage} <span className="sr-only">{title}</span>
          </Link>
        ) : null}
        {active && !expired ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => accept.mutate()}
            className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
          >
            {acceptLabel} <span className="sr-only">{title}</span>
          </button>
        ) : null}
        {active ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => reject.mutate()}
            className="underline disabled:opacity-60"
          >
            {INSIGHTS_COPY.dismiss} <span className="sr-only">{title}</span>
          </button>
        ) : null}
      </div>
    </li>
  );
}

function requestProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_CONSENT_REQUIRED' || error.code === 'AI_CONSENT_VERSION_MISMATCH') {
      return INSIGHTS_COPY.consent;
    }
    if (error.code === 'AI_DISABLED_FOR_STUDY') return INSIGHTS_COPY.disabledForStudy;
    if (error.status === 429) return INSIGHTS_COPY.limited;
  }
  return INSIGHTS_COPY.unavailable;
}
