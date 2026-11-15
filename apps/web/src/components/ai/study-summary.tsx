'use client';

import type {
  NodeSummary,
  StudySummary,
  SummaryEvidenceRef,
  SummaryItem,
} from '@bible-artisan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { fetchStudySummary, requestStudySummary, studySummaryQueryKey } from '@/lib/ai';
import { ApiError } from '@/lib/api-client';
import { bibleHref } from '@/lib/bible';
import { useGraphViewStore } from '@/lib/graph-store';
import { listNodes, nodeOptionText, nodesQueryKey } from '@/lib/nodes';
import { listNotes, notesQueryKey } from '@/lib/notes';

export const SUMMARY_COPY = {
  heading: 'Study summary',
  badge: 'AI Summary of Your Study',
  none: 'No summary yet. Your notes and conclusions are always available without one.',
  generate: 'Generate summary',
  regenerate: 'Regenerate summary',
  generating: 'Generating a summary…',
  stale: 'Based on an earlier version of this study',
  failed: "The latest summary couldn't be generated. The last valid summary is still shown.",
  requestFailed: "Couldn't ask for a summary right now. Your study is unchanged.",
  loadFailed: "The summary couldn't be loaded. Your study is unaffected.",
  consent: 'Turn on AI features in Settings to get a summary.',
  disabledForStudy: 'AI features are turned off for this study.',
  limited: 'You have reached the AI request limit. Try again later.',
  focus: 'Focus',
  evidence: 'Evidence',
  you: 'You',
  aiSynthesis: 'AI synthesis',
  sourceInterpretation: 'Source interpretation',
  suggestion: 'Suggestion only',
  coverage: 'Coverage',
} as const;

const SECTIONS: { key: keyof StudySummary; title: string; suggestion?: boolean }[] = [
  { key: 'keyPassages', title: 'Key passages' },
  { key: 'textualObservations', title: 'Textual observations' },
  { key: 'establishedFindings', title: 'Established findings' },
  { key: 'tentativeFindings', title: 'Tentative findings' },
  { key: 'tensions', title: 'Tensions' },
  { key: 'abandonedHypotheses', title: 'Abandoned hypotheses' },
  { key: 'nextDirections', title: 'Next directions', suggestion: true },
  { key: 'proposedQuestions', title: 'Questions to consider', suggestion: true },
];

const ATTRIBUTION: Record<SummaryItem['attribution'], string> = {
  user_statement: SUMMARY_COPY.you,
  ai_synthesis: SUMMARY_COPY.aiSynthesis,
  source_interpretation: SUMMARY_COPY.sourceInterpretation,
};

/**
 * The living study summary (BIB-43; PRD sections 16, 17): an "AI Summary of Your Study" with its
 * freshness. A summary on an older basis says "Based on an earlier version of this study"; a
 * failed regeneration keeps the last valid summary and says so. Open questions and conclusions
 * are the study's own (statuses set only by the user). Every item names its attribution and its
 * evidence in text, never by color alone. Each cited node or note still in the study is a button
 * that opens it (its detail or the note), and a passage no longer in the study links to the reader
 * (BIB-53: follow a citation).
 */
export function StudySummaryPanel({
  studyId,
  active,
  onOpenNote,
}: {
  studyId: string;
  active: boolean;
  /** Opens a cited note in the Notes panel; without it, notes are cited in text only. */
  onOpenNote?: (noteId: string) => void;
}) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const graphView = useGraphViewStore();
  const [problem, setProblem] = useState<string | null>(null);
  const summary = useQuery({
    queryKey: studySummaryQueryKey(studyId),
    queryFn: () => fetchStudySummary(studyId),
    refetchInterval: (query) => (query.state.data?.generating ? 2000 : false),
  });
  const nodes = useQuery({ queryKey: nodesQueryKey(studyId), queryFn: () => listNodes(studyId) });
  const generating = summary.data?.generating ?? false;
  const citesNotes =
    onOpenNote !== undefined &&
    SECTIONS.some(({ key }) =>
      ((summary.data?.summary?.[key] ?? []) as SummaryItem[]).some((item) =>
        item.evidenceRefs.some((ref) => ref.type === 'note_version'),
      ),
    );
  // The Notes panel's own list (the same cache entry): a note cited but since trashed stays text.
  const notes = useQuery({
    queryKey: notesQueryKey(studyId, 'active'),
    queryFn: () => listNotes(studyId, 'active'),
    enabled: citesNotes,
  });

  const ask = useMutation({
    mutationFn: () => requestStudySummary(studyId, crypto.randomUUID()),
    onMutate: () => setProblem(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: studySummaryQueryKey(studyId) }),
    onError: (error) => setProblem(requestProblem(error)),
  });

  const nodeOf = (nodeId: string): NodeSummary | undefined =>
    nodes.data?.items.find((node: NodeSummary) => node.id === nodeId);

  /** Selects the node and moves focus to its detail, as the Nodes list does (narrow: Notes tab). */
  const showNode = (nodeId: string) =>
    graphView.getState().select([nodeId], 'list', { focusDetail: true });

  const citation = (ref: SummaryEvidenceRef): ReactNode => {
    const quote = 'quote' in ref && ref.quote ? ` — “${ref.quote}”` : '';
    const follow = (label: string, onClick: () => void) => (
      <>
        <button type="button" onClick={onClick} className="text-accent underline">
          {label}
        </button>
        {quote}
      </>
    );
    switch (ref.type) {
      case 'scripture': {
        if (nodeOf(ref.nodeId)) return follow(ref.label, () => showNode(ref.nodeId));
        if (!ref.referenceId) return `${ref.label}${quote}`;
        return (
          <>
            <Link href={bibleHref(ref.referenceId, studyId)} className="text-accent underline">
              {ref.label}
            </Link>
            {quote}
          </>
        );
      }
      case 'node_version':
      case 'source': {
        const found = nodeOf(ref.nodeId);
        if (!found) return `An item no longer in this study${quote}`;
        return follow(nodeOptionText(found), () => showNode(ref.nodeId));
      }
      case 'note_version': {
        const note = notes.data?.items.find((candidate) => candidate.id === ref.noteId);
        if (!note || !onOpenNote) return `A note${quote}`;
        return follow(`Note: ${note.preview || 'Empty note'}`, () => onOpenNote(ref.noteId));
      }
      case 'event':
        return 'An entry in the study history';
    }
  };

  const data = summary.data;
  const current = data?.summary ?? null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-serif text-2xl">
        {SUMMARY_COPY.heading}
      </h2>
      {/* A passive panel: failing to load it is not an alert about the user's action. */}
      {summary.isError ? <p className="text-muted">{SUMMARY_COPY.loadFailed}</p> : null}
      {data && !current ? <p className="text-muted">{SUMMARY_COPY.none}</p> : null}
      {generating ? <p role="status">{SUMMARY_COPY.generating}</p> : null}
      {data?.lastFailure ? <p role="alert">{SUMMARY_COPY.failed}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {active && data ? (
        <button
          type="button"
          // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
          aria-disabled={generating || ask.isPending ? true : undefined}
          onClick={() => {
            if (!generating && !ask.isPending) ask.mutate();
          }}
          className="self-start rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
        >
          {current ? SUMMARY_COPY.regenerate : SUMMARY_COPY.generate}
        </button>
      ) : null}
      {current ? (
        <article className="flex flex-col gap-3 rounded border border-dashed border-muted p-3">
          <p>
            <span className="rounded bg-muted/20 px-1 text-sm font-medium">
              {SUMMARY_COPY.badge}
            </span>{' '}
            {data?.stale ? <span className="text-sm font-medium">{SUMMARY_COPY.stale}</span> : null}
          </p>
          <p className="break-words">
            <span className="font-medium">{SUMMARY_COPY.focus}: </span>
            {current.focus}
          </p>
          {current.openQuestions.length > 0 ? (
            <div>
              <h3 className="font-medium">Open questions</h3>
              <ul className="list-disc pl-5">
                {current.openQuestions.map((question) => (
                  <li key={question.nodeId} className="break-words">
                    {question.text} ({question.status.replace('_', ' ')}) · {SUMMARY_COPY.you}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {current.conclusions.length > 0 ? (
            <div>
              <h3 className="font-medium">Conclusions</h3>
              <ul className="list-disc pl-5">
                {current.conclusions.map((conclusion) => (
                  <li key={conclusion.nodeId} className="break-words">
                    {conclusion.text} ({conclusion.status}
                    {conclusion.established ? ', established by me' : ''}) · {SUMMARY_COPY.you}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {SECTIONS.map(({ key, title, suggestion }) => {
            const items = current[key] as SummaryItem[];
            if (items.length === 0) return null;
            return (
              <div key={key}>
                <h3 className="font-medium">{title}</h3>
                <ul className="flex flex-col gap-2">
                  {items.map((item) => (
                    <li key={item.id} className="break-words">
                      <p>
                        {item.text}{' '}
                        <span className="text-sm text-muted">
                          ({suggestion ? SUMMARY_COPY.suggestion : ATTRIBUTION[item.attribution]})
                        </span>
                      </p>
                      {item.evidenceRefs.length > 0 ? (
                        <p className="text-sm">
                          {SUMMARY_COPY.evidence}:{' '}
                          {item.evidenceRefs.map((ref, index) => (
                            // Refs have no id of their own, and their order is fixed.
                            <Fragment key={index}>
                              {index > 0 ? '; ' : null}
                              {citation(ref)}
                            </Fragment>
                          ))}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {current.coverageWarnings.length > 0 ? (
            <p className="text-sm text-muted">
              {SUMMARY_COPY.coverage}: {current.coverageWarnings.join(' ')}
            </p>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function requestProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_CONSENT_REQUIRED' || error.code === 'AI_CONSENT_VERSION_MISMATCH') {
      return SUMMARY_COPY.consent;
    }
    if (error.code === 'AI_DISABLED_FOR_STUDY') return SUMMARY_COPY.disabledForStudy;
    if (error.status === 429) return SUMMARY_COPY.limited;
  }
  return SUMMARY_COPY.requestFailed;
}
