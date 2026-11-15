'use client';

import type { ReasoningPathResponse, ReasoningStep } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { fetchReasoning, reasoningQueryKey } from '@/lib/ai';
import { formatNodeTime } from '@/lib/nodes';

export const REASONING_COPY = {
  open: 'How did I arrive at this?',
  close: 'Hide how I arrived at this',
  heading: 'How you arrived at this',
  intro: 'Only what your study recorded, oldest first. Missing steps are listed, never guessed.',
  loading: 'Loading the recorded path…',
  failed: "Couldn't load the recorded path. Try again.",
  gaps: 'What the record does not show',
  noEvidence: 'No evidence recorded',
  evidence: 'Evidence: ',
  removed: ' (relationship removed or changed since)',
  changed: ' (edited or deleted since)',
} as const;

/**
 * "How Did I Arrive at This" for a conclusion (BIB-45; PRD section 16 "Reasoning
 * reconstruction", section 18): the deterministic path from the study's own record (conclusion
 * versions with their evidence, and the history entries about it), with every gap stated. Needs
 * no AI, so it works with AI off or unavailable. Collapsed until opened.
 */
export function ReasoningPath({ studyId, nodeId }: { studyId: string; nodeId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="self-start underline"
      >
        {open ? REASONING_COPY.close : REASONING_COPY.open}
      </button>
      {open ? <ReasoningPanel id={panelId} studyId={studyId} nodeId={nodeId} /> : null}
    </div>
  );
}

function ReasoningPanel({ id, studyId, nodeId }: { id: string; studyId: string; nodeId: string }) {
  const headingId = useId();
  const path = useQuery({
    queryKey: reasoningQueryKey(studyId, nodeId),
    queryFn: () => fetchReasoning(studyId, nodeId),
  });
  return (
    <section id={id} aria-labelledby={headingId} className="flex flex-col gap-2 rounded border p-3">
      <h5 id={headingId} className="font-medium">
        {REASONING_COPY.heading}
      </h5>
      <p className="text-sm text-muted">{REASONING_COPY.intro}</p>
      {path.isPending ? <p role="status">{REASONING_COPY.loading}</p> : null}
      {path.isError ? <p role="alert">{REASONING_COPY.failed}</p> : null}
      {path.data ? (
        <>
          <ol className="list-decimal pl-5">
            {path.data.steps.map((step) => (
              <li
                key={step.kind === 'version' ? step.versionId : step.eventId}
                className="break-words"
              >
                {stepText(step)}
              </li>
            ))}
          </ol>
          {path.data.gaps.length > 0 ? (
            <div>
              <h6 className="text-sm font-medium">{REASONING_COPY.gaps}</h6>
              <ul className="list-disc pl-5 text-sm">
                {path.data.gaps.map((gap, index) => (
                  <li key={`${gap.code}-${gap.versionId ?? ''}-${gap.edgeId ?? ''}-${index}`}>
                    {gapText(gap, path.data.steps)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** A gap about one version names that version, so it never reads as being about the latest. */
function gapText(gap: ReasoningPathResponse['gaps'][number], steps: ReasoningStep[]): string {
  const version = steps.find((step) => step.kind === 'version' && step.versionId === gap.versionId);
  return version?.kind === 'version'
    ? `Version ${version.versionNumber}: ${gap.message}`
    : gap.message;
}

function stepText(step: ReasoningStep): string {
  if (step.kind === 'event') {
    return `${formatNodeTime(step.occurredAt)}: ${step.eventType.replaceAll('_', ' ')}`;
  }
  const marker = step.established ? ', established by me' : '';
  const evidence =
    step.evidence.length === 0
      ? REASONING_COPY.noEvidence
      : REASONING_COPY.evidence +
        step.evidence
          .map(
            (item) =>
              `${item.edgeType.replaceAll('_', ' ')} ${item.label}${
                !item.edgeLive
                  ? REASONING_COPY.removed
                  : !item.nodeLive || item.nodeChangedSince
                    ? REASONING_COPY.changed
                    : ''
              }`,
          )
          .join('; ');
  return `${formatNodeTime(step.createdAt)}: version ${step.versionNumber} (${step.action}, ${step.status}${marker}) “${step.statement}”. ${evidence}.`;
}
