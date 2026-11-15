'use client';

import { PANE_NAMES, type PaneName, type StudyResponse } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useId, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { StudyInsights } from '@/components/ai/study-insights';
import { StudySummaryPanel } from '@/components/ai/study-summary';
import { ExportControls } from '@/components/exports/export-controls';
import { GraphSection } from '@/components/graph/graph-section';
import { UndoControls } from '@/components/graph/undo-controls';
import { NodesSection } from '@/components/nodes/nodes-section';
import { NotesPanel } from '@/components/notes/notes-panel';
import { RequireAuth } from '@/components/require-auth';
import { ThreadPanel } from '@/components/thread/thread-panel';
import { classifyError } from '@/lib/api-errors';
import { bibleHref } from '@/lib/bible';
import { createStudyExport } from '@/lib/exports';
import { GraphViewProvider } from '@/lib/graph-store';
import { fetchResume, resumeQueryKey } from '@/lib/resume';
import { fetchStudy, studyQueryKey } from '@/lib/studies';
import { useEndSessionOnLeave } from '@/lib/study-session';
import { useNarrowViewport } from '@/lib/viewport';
import { StudyEditor } from './study-editor';
import { StudyLifecycleActions } from './study-lifecycle-actions';
import { StudyLimitsNotice } from './study-limits-notice';
import { ViewStateSaver } from './view-state-saver';
import {
  FollowNodeDetail,
  type WorkspaceTab,
  WorkspacePanel,
  WorkspaceTabList,
  WORKSPACE_TABS,
} from './workspace-tabs';

/** The saved open pane, when it is one of the workspace's tabs (BIB-34). */
function savedTab(panes: Partial<Record<PaneName, boolean>> | null): WorkspaceTab | null {
  if (!panes) return null;
  return WORKSPACE_TABS.find((tab) => panes[tab] === true) ?? null;
}

const isPaneName = (tab: WorkspaceTab): tab is WorkspaceTab & PaneName =>
  (PANE_NAMES as readonly string[]).includes(tab);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(value: string | null): string | null {
  return value !== null && UUID.test(value) ? value.toLowerCase() : null;
}

const EXPORT_COPY: ProblemCopy = {
  notFound: "This study isn't available.",
  refused: "Couldn't export this study.",
  unavailable: "Couldn't export this study.",
};

const LOAD_COPY: ProblemCopy = {
  notFound: "This study isn't available.",
  refused: "Couldn't load this study.",
  unavailable: "Couldn't load this study.",
};

/**
 * `/studies/:id` (BIB-19, BIB-20, BIB-22): a minimal page that reads back the study and edits its
 * title, description, main question, pin and tags, so a study can be opened, organized and
 * reloaded. It archives, unarchives, trashes and restores the study; an archived or trashed study
 * stays readable but has no editor. Its graph canvas (BIB-28), typed nodes (BIB-25) and notes
 * (BIB-23) follow the editor; the canvas and the Nodes list share one selection. The Study Thread
 * (BIB-32) follows the notes, then the living summary (BIB-43) and the study-wide AI suggestions
 * (BIB-44/45, collapsed). A missing or another user's study, or one past its trash window, shows the same
 * neutral unavailable state.
 *
 * BIB-38: below 900 px the same regions become Reader, Notes, Thread, Summary and Graph Preview
 * tabs (PRD section 11). Every region stays mounted, so unsaved notes and edits survive a tab
 * switch or a rotation across the breakpoint; the Notes tab carries the Nodes list, whose Add node
 * form captures a question or thought without the canvas.
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
  const searchParams = useSearchParams();
  const nodeParam = searchParams.get('node');
  // `?branch=<id>` (BIB-34, Home's Resume): the branch shown alone, if it is one of the study's.
  const branchParam = uuidOrNull(searchParams.get('branch'));
  const showOriginal =
    study.originalQuestion !== null && study.originalQuestion.nodeId !== study.mainQuestion?.nodeId;
  const narrow = useNarrowViewport();
  const idBase = useId();
  // A link to a node (`?node=`) opens where its detail is: the Nodes list on the Notes tab.
  // Null until something opens a tab: then the saved pane (BIB-34), else Reader, is shown.
  const [openedTab, setTab] = useState<WorkspaceTab | null>(nodeParam ? 'notes' : null);
  /** The tab the user picked (saved as the open pane); null until they pick one. */
  const [pickedTab, setPickedTab] = useState<WorkspaceTab | null>(null);
  const pickTab = useCallback((next: WorkspaceTab) => {
    setTab(next);
    setPickedTab(next);
  }, []);
  // BIB-34: the saved view state (the same read as Home's resume card), restored once: the open
  // pane, the canvas viewport and the reader's passage. Best effort: without it the page opens
  // as before.
  const saved = useQuery({
    queryKey: resumeQueryKey(study.id),
    queryFn: () => fetchResume(study.id),
    retry: false,
  });
  const viewState = saved.data?.viewState ?? null;
  // A link to a node, or a tab opened on this page, wins over the saved pane.
  const tab: WorkspaceTab = openedTab ?? savedTab(viewState?.panes ?? null) ?? 'reader';
  // BIB-33: leaving the study ends this tab's session in it at once.
  useEndSessionOnLeave(study.id, study.lifecycle === 'active');
  const unsavedTabs = new Set<WorkspaceTab>();
  if (unsavedEdits) unsavedTabs.add('reader');
  if (unsavedNote) unsavedTabs.add('notes');
  const panel = { idBase, narrow, selected: tab };
  const openNotes = useCallback(() => setTab('notes'), []);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
      <h1 className="font-serif text-4xl break-words">{study.title}</h1>
      {/* BIB-52: warnings from 80% of a safety cap, and what still works at one (every tab). */}
      <StudyLimitsNotice studyId={study.id} />
      {narrow ? (
        <WorkspaceTabList idBase={idBase} selected={tab} onSelect={pickTab} unsaved={unsavedTabs} />
      ) : null}
      <WorkspacePanel {...panel} tab="reader">
        <StudyLifecycleActions
          study={study}
          onReload={onReload}
          unsavedEdits={unsavedEdits || unsavedNote}
        />
        <ExportControls
          label="Export this study"
          description="Saved changes only. The download link works for 15 minutes; the file is kept for 24 hours."
          create={(format, idempotencyKey) => createStudyExport(study.id, format, idempotencyKey)}
          copy={EXPORT_COPY}
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
      </WorkspacePanel>
      <GraphViewProvider initialSoloBranchId={branchParam}>
        {/* BIB-34: saves the selection, branch, viewport and pane the user picks, for Resume. */}
        <ViewStateSaver
          studyId={study.id}
          active={study.lifecycle === 'active'}
          openedNodeId={uuidOrNull(nodeParam)}
          openedBranchId={branchParam}
          openPane={pickedTab && isPaneName(pickedTab) ? pickedTab : null}
        />
        <FollowNodeDetail enabled={narrow} onOpen={openNotes} />
        <WorkspacePanel {...panel} tab="graph">
          {/* BIB-63: undo / redo recent graph and content changes, outside the canvas so it stays
              reachable when the graph is empty or shown as List View. */}
          <UndoControls studyId={study.id} editable={study.lifecycle === 'active'} />
          {/* BIB-28: the canvas, wider than the text column; read-only unless active and wide.
              BIB-29: or the same graph as List View (the default below 900 px). */}
          <div className="w-[min(72rem,calc(100vw-2rem))] self-center">
            <GraphSection
              study={study}
              onReload={onReload}
              savedViewport={viewState?.viewport ?? null}
            />
          </div>
        </WorkspacePanel>
        <WorkspacePanel {...panel} tab="notes">
          {/* BIB-25: the study's typed nodes, readable in every state. Its Add node form is the
              canvas-free way to capture a question or thought (BIB-38). */}
          <NodesSection study={study} onReload={onReload} initialNodeId={nodeParam} />
          <NotesPanel study={study} onReload={onReload} onUnsavedChange={setUnsavedNote} />
        </WorkspacePanel>
      </GraphViewProvider>
      <WorkspacePanel {...panel} tab="thread">
        {/* BIB-32: what happened in this study, newest first. */}
        <ThreadPanel study={study} />
      </WorkspacePanel>
      <WorkspacePanel {...panel} tab="summary">
        {/* BIB-43: the living summary; BIB-44/45: study-wide AI suggestions (collapsed). */}
        <StudySummaryPanel studyId={study.id} active={study.lifecycle !== 'trashed'} />
        <StudyInsights studyId={study.id} active={study.lifecycle === 'active'} />
      </WorkspacePanel>
      <nav aria-label="Study" className="flex flex-wrap gap-4">
        {/* BIB-24: the reader with this study's highlights (opaque ids only in the URL). */}
        <Link
          // BIB-34: back to the reader's saved passage, else the starting passage.
          href={bibleHref(
            viewState?.readerReferenceId ?? study.startingReference?.id ?? null,
            study.id,
          )}
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
