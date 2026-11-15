'use client';

import type { LimitUsage, StudyLimitsResponse } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { fetchLimits, limitsQueryKey } from '@/lib/limits';

type Resource = keyof StudyLimitsResponse;

const count = (n: number) => n.toLocaleString('en-US');
const megabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;

/** Fixed copy per resource and state; counts only, never content. */
const COPY: Record<Resource, (usage: LimitUsage) => { near: string; reached: string }> = {
  nodes: ({ used, limit }) => ({
    near: `Near the node limit: ${count(used)} of ${count(limit)} nodes in this study.`,
    reached: `Node limit reached: this study has ${count(limit)} nodes. Delete nodes you no longer need before adding more.`,
  }),
  edges: ({ used, limit }) => ({
    near: `Near the relationship limit: ${count(used)} of ${count(limit)} relationships in this study.`,
    reached: `Relationship limit reached: this study has ${count(limit)} relationships. Remove relationships you no longer need before adding more.`,
  }),
  events: ({ used, limit }) => ({
    near: `Near the history limit: ${count(used)} of ${count(limit)} recorded events in this study. Consider starting a new study for the next stage.`,
    reached: `History limit reached: this study has ${count(limit)} recorded events, so additions are paused. Start a new study to continue.`,
  }),
  storage: ({ used, limit }) => ({
    near: `Near your storage limit: ${megabytes(used)} of ${megabytes(limit)} used across your studies.`,
    reached: `Storage limit reached: ${megabytes(limit)} used across your studies. Delete studies you no longer need before adding more.`,
  }),
};

const ORDER: readonly Resource[] = ['nodes', 'edges', 'events', 'storage'];

/**
 * Safety-cap warnings for the study page (BIB-52; NFR-SCALE-002: "warn at 80% and preserve
 * export/delete/read access at the cap"; PRD section 28: "blocking additions with an
 * explanation"). Shows nothing while every count is below 80% or while the usage cannot be read
 * (a failed read must not block the page). Each line says in words whether the study is near or
 * at a limit, so neither color nor position is the only signal.
 */
export function StudyLimitsNotice({ studyId }: { studyId: string }) {
  const limits = useQuery({
    queryKey: limitsQueryKey(studyId),
    queryFn: () => fetchLimits(studyId),
  });
  if (!limits.data) return null;
  const data = limits.data;
  const lines = ORDER.filter((resource) => data[resource].state !== 'ok').map((resource) => {
    const usage = data[resource];
    const copy = COPY[resource](usage);
    return {
      resource,
      reached: usage.state === 'reached',
      text: usage.state === 'reached' ? copy.reached : copy.near,
    };
  });
  if (lines.length === 0) return null;
  const anyReached = lines.some((line) => line.reached);
  return (
    <section
      aria-labelledby="study-limits-heading"
      className="flex flex-col gap-2 rounded border border-accent px-4 py-3"
    >
      <h2 id="study-limits-heading" className="font-medium">
        {anyReached ? 'Study limit reached' : 'Approaching a study limit'}
      </h2>
      <ul role="status" className="flex list-disc flex-col gap-1 pl-5">
        {lines.map((line) => (
          <li key={line.resource}>{line.text}</li>
        ))}
      </ul>
      {anyReached ? (
        <p className="text-sm text-muted">
          You can still read, export, archive and delete. Only additions are paused.
        </p>
      ) : null}
    </section>
  );
}
