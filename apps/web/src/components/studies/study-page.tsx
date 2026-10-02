'use client';

import type { StudyResponse } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { NodesSection } from '@/components/nodes/nodes-section';
import { NotesPanel } from '@/components/notes/notes-panel';
import { RequireAuth } from '@/components/require-auth';
import { classifyError } from '@/lib/api-errors';
import { bibleHref } from '@/lib/bible';
import { fetchStudy, studyQueryKey } from '@/lib/studies';
import { StudyEditor } from './study-editor';
import { StudyLifecycleActions } from './study-lifecycle-actions';

const LOAD_COPY: ProblemCopy = {
  notFound: "This study isn't available.",
  refused: "Couldn't load this study.",
  unavailable: "Couldn't load this study.",
};

/**
 * `/studies/:id` (BIB-19, BIB-20, BIB-22): a minimal page that reads back the study and edits its
 * title, description, main question, pin and tags, so a study can be opened, organized and
 * reloaded. It archives, unarchives, trashes and restores the study; an archived or trashed study
 * stays readable but has no editor. Its typed nodes (BIB-25) and notes (BIB-23) are listed below
 * the editor. The canvas, thread and summary arrive with later tickets. A missing or another user's study, or one past its trash window, shows the same
 * neutral unavailable state.
 */
export function StudyPage() {
  const params = useParams<{ studyId: string }>();
  const studyId = params.studyId;
  return <RequireAuth>{() => <StudyView studyId={studyId} />}</RequireAuth>;
}

function StudyView({ studyId }: { studyId: string }) {
  const study = useQuery({
    queryKey: studyQueryKey(studyId),
    queryFn: () => fetchStudy(studyId),
    retry: false,
  });

  if (study.data) {
    return (
      <StudyDetails study={study.data} onReload={() => study.refetch({ throwOnError: true })} />
    );
  }

  if (study.isError) {
    const notFound = classifyError(study.error).kind === 'not_found';
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12">
        {notFound ? (
          <>
            <h1 className="font-serif text-3xl">This study isn&apos;t available.</h1>
            <p className="text-muted">It may have been removed, or the link may be wrong.</p>
          </>
        ) : (
          <ProblemAlert error={study.error} copy={LOAD_COPY} onRetry={() => void study.refetch()} />
        )}
        <Link href="/" className="text-accent underline">
          Go home
        </Link>
      </main>
    );
  }

  return (
    <main aria-busy="true" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12">
      <p role="status" className="text-muted">
        Loading the study…
      </p>
    </main>
  );
}

function StudyDetails({
  study,
  onReload,
}: {
  study: StudyResponse;
  onReload: () => Promise<unknown>;
}) {
  // The editor's and the open note's unsaved work, so archiving or trashing never silently
  // discards it (BIB-22, BIB-23).
  const [unsavedEdits, setUnsavedEdits] = useState(false);
  const [unsavedNote, setUnsavedNote] = useState(false);
  // `?node=<id>` (BIB-26, e.g. the reader's "Show in study"): an opaque id, selected if listed.
  const nodeParam = useSearchParams().get('node');
  const showOriginal =
    study.originalQuestion !== null && study.originalQuestion.nodeId !== study.mainQuestion?.nodeId;
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
      <h1 className="font-serif text-4xl break-words">{study.title}</h1>
      <StudyLifecycleActions
        study={study}
        onReload={onReload}
        unsavedEdits={unsavedEdits || unsavedNote}
      />
      {study.pinned ? <p className="text-sm text-muted">Pinned study</p> : null}
      {study.description ? (
        <p className="break-words whitespace-pre-wrap">{study.description}</p>
      ) : null}
      <dl className="flex flex-col gap-4">
        <div>
          <dt className="font-medium">Starting passage</dt>
          <dd>
            {study.startingReference ? (
              <Link
                href={bibleHref(study.startingReference.id, study.id)}
                className="text-accent underline"
              >
                {study.startingReference.label}
              </Link>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Main question</dt>
          <dd className="break-words whitespace-pre-wrap">
            {study.mainQuestion ? (
              study.mainQuestion.text
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
        {showOriginal && study.originalQuestion ? (
          <div>
            <dt className="font-medium">Original question</dt>
            <dd className="break-words whitespace-pre-wrap">{study.originalQuestion.text}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">Tags</dt>
          <dd>
            {study.tags.length > 0 ? (
              study.tags.map((tag) => tag.name).join(', ')
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
        </div>
      </dl>
      {/* Read-only while archived or in the trash: the server refuses edits then anyway. Archive
          and Move to trash wait while the editor holds unsaved work. */}
      {study.lifecycle === 'active' ? (
        <StudyEditor study={study} onReload={onReload} onUnsavedChange={setUnsavedEdits} />
      ) : null}
      {/* BIB-25: the study's typed nodes, readable in every state. */}
      <NodesSection study={study} onReload={onReload} initialNodeId={nodeParam} />
      <NotesPanel study={study} onReload={onReload} onUnsavedChange={setUnsavedNote} />
      <p className="text-muted">
        The study is saved. The workspace for its graph, thread and summary arrives in a later
        release.
      </p>
      <nav aria-label="Study" className="flex flex-wrap gap-4">
        {/* BIB-24: the reader with this study's highlights (opaque ids only in the URL). */}
        <Link
          href={bibleHref(study.startingReference?.id ?? null, study.id)}
          className="text-accent underline"
        >
          Read in this study
        </Link>
        <Link href="/" className="text-accent underline">
          Home
        </Link>
        <Link href="/studies/new" className="text-accent underline">
          New study
        </Link>
      </nav>
    </main>
  );
}
