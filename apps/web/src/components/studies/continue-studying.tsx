'use client';

import { NODE_STATUS_NAMES, type ResumeResponse } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useId } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { formatNodeTime, studyNodeHref } from '@/lib/nodes';
import { fetchResume, resumeHref, resumeQueryKey, studyContextHref } from '@/lib/resume';
import { libraryQueryKey, listStudies, studyHref } from '@/lib/studies';
import { RECENT } from './recent-studies';

const COPY: ProblemCopy = {
  notFound: "Couldn't load where you left off.",
  refused: "Couldn't load where you left off.",
  unavailable: "Couldn't load where you left off.",
};

/**
 * Home's "Continue studying" card (BIB-34; PRD sections 11, 18): the most recently active study's
 * saved question, branch, last passage, latest conclusion and up to three open questions, from
 * `GET /studies/:id/resume`. Deterministic: no AI, so it reads the same with AI off. "Resume from
 * last point" restores the saved context in one action; the server already applied the
 * deleted-context fallback. Shares Home's recent-studies listing, so it adds one request.
 */
export function ContinueStudying() {
  const recent = useQuery({
    queryKey: libraryQueryKey(RECENT),
    queryFn: () => listStudies(RECENT, null),
  });
  const latest = recent.data?.items[0] ?? null;
  const resume = useQuery({
    queryKey: latest ? resumeQueryKey(latest.id) : ['studies', 'none', 'resume'],
    queryFn: () => {
      if (!latest) throw new Error('no study');
      return fetchResume(latest.id);
    },
    enabled: latest !== null,
  });

  // No studies yet (or the listing failed): Recent studies says so.
  if (!latest) return null;
  if (resume.data) return <ResumeCard resume={resume.data} />;
  if (resume.isError) {
    return <ProblemAlert error={resume.error} copy={COPY} onRetry={() => void resume.refetch()} />;
  }
  return (
    <p aria-busy="true" className="text-muted">
      Loading where you left off…
    </p>
  );
}

function ResumeCard({ resume }: { resume: ResumeResponse }) {
  const headingId = useId();
  const { studyId, openQuestions } = resume;
  const firstOpen = openQuestions.items[0];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded border border-accent px-4 py-4"
    >
      <h2 id={headingId} className="font-serif text-2xl">
        Continue studying
      </h2>
      <p className="break-words font-medium">{resume.title}</p>
      <p className="text-sm text-muted">Last activity {formatNodeTime(resume.lastActivityAt)}</p>
      <dl className="flex flex-col gap-2">
        <div>
          <dt className="font-medium">Question</dt>
          <dd className="break-words">
            {resume.activeQuestion ? (
              <>
                {resume.activeQuestion.text}{' '}
                <span className="text-muted">
                  ({NODE_STATUS_NAMES[resume.activeQuestion.status]})
                </span>
              </>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
        {resume.activeBranch ? (
          <div>
            <dt className="font-medium">Branch</dt>
            <dd className="break-words">{resume.activeBranch.rootLabel ?? 'A branch'}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">Last passage</dt>
          <dd>
            {resume.lastPassage ? (
              resume.lastPassage.label
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Latest conclusion</dt>
          <dd className="break-words">
            {resume.recentConclusion ? (
              <>
                {resume.recentConclusion.text}{' '}
                <span className="text-muted">
                  ({NODE_STATUS_NAMES[resume.recentConclusion.status]})
                </span>
              </>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Open questions ({openQuestions.total})</dt>
          <dd>
            {openQuestions.items.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {openQuestions.items.map((question) => (
                  <li key={question.nodeId}>
                    <Link
                      href={studyNodeHref(studyId, question.nodeId)}
                      className="break-words text-accent underline"
                    >
                      {question.text}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">None open</span>
            )}
            {openQuestions.total > openQuestions.items.length ? (
              <Link href={studyHref(studyId)} className="text-accent underline">
                View all open questions
              </Link>
            ) : null}
          </dd>
        </div>
      </dl>
      {resume.target.fallback ? (
        <p className="text-sm text-muted">
          What you last had open was deleted, so this resumes at the nearest saved point.
        </p>
      ) : null}
      <nav aria-label="Continue studying" className="flex flex-wrap gap-4">
        <Link
          href={resumeHref(studyId, resume.target)}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Resume from last point
        </Link>
        <Link href={studyHref(studyId)} className="text-accent underline">
          Open graph
        </Link>
        {firstOpen ? (
          <Link
            href={studyContextHref(studyId, firstOpen.nodeId, resume.activeBranch?.id ?? null)}
            className="text-accent underline"
          >
            Explore open questions
          </Link>
        ) : null}
      </nav>
    </section>
  );
}
