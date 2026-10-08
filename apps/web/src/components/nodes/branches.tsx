'use client';

import {
  type Branch,
  BRANCH_EXISTS,
  BRANCH_ROOT_TYPES,
  type CreateBranchRequest,
  type StudyNodeType,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BRANCH_COPY,
  branchRuleText,
  membersProblem,
  useBranchMembers,
} from '@/components/graph/use-branch-members';
import { branchLabel, createBranch, inBranch, storeBranch } from '@/lib/branches';
import { fetchGraph, graphQueryKey, invalidateGraph } from '@/lib/graph';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import {
  codeOf,
  isLifecycle,
  type Problem,
  ProblemLine,
  statusOf,
  useFrozenRequest,
} from './relationship-controls';

const ROOT_TYPES: ReadonlySet<StudyNodeType> = new Set(BRANCH_ROOT_TYPES);

/**
 * The open node's branches (BIB-60), read from the graph snapshot the Graph section already holds
 * (the same query, not a fetch of its own). On an active study: one checkbox per branch, checked
 * when this node is the branch's root or a member, each change one membership request with that
 * branch's revision; the branch this node roots is checked and unavailable, with "(root)" in text.
 * "Start a branch here" for a Question or Scripture node that roots no branch. This form is the
 * keyboard path for branch membership at every width; nothing drags. A read-only study lists the
 * node's branches as text.
 */
export function Branches({
  studyId,
  node,
  studyRevision,
  editable,
  onLocked,
}: {
  studyId: string;
  node: { id: string; type: StudyNodeType };
  /** The study's current revision: starting a branch is a study change. */
  studyRevision: number;
  editable: boolean;
  onLocked: () => void;
}) {
  const queryClient = useQueryClient();
  const legendId = useId();
  // The Graph section's snapshot: opening a node's detail never refetches it (that section keeps
  // it fresh); it is fetched here only when nothing has loaded it yet.
  const graph = useQuery({
    queryKey: graphQueryKey(studyId),
    queryFn: () => fetchGraph(studyId),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const members = useBranchMembers(studyId);
  const starting = useFrozenRequest((body: CreateBranchRequest, key: string) =>
    createBranch(studyId, body, key),
  );
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<(Problem & { from: 'members' | 'start' }) | null>(null);
  const boxes = useRef(new Map<string, HTMLInputElement>());
  /** After a start: the new branch's checkbox takes focus once it renders. */
  const focusBranch = useRef<string | null>(null);
  /** What the membership change in flight (or held for Retry) announces when it is saved. */
  const membersDone = useRef('');

  const branches = graph.data?.branches;
  const nodesById = useMemo(
    () => new Map((graph.data?.nodes ?? []).map((n) => [n.id, n])),
    [graph.data?.nodes],
  );

  useEffect(() => {
    if (!focusBranch.current || !branches) return;
    const box = boxes.current.get(focusBranch.current);
    if (!box) return;
    focusBranch.current = null;
    box.focus();
  }, [branches]);

  const pending = members.pending || starting.pending;
  const roots = branches?.some((branch) => branch.rootNodeId === node.id) ?? true;
  const canStart = editable && ROOT_TYPES.has(node.type) && !roots;

  async function toggle(branch: Branch) {
    if (pending || branch.rootNodeId === node.id) return;
    const member = branch.memberNodeIds.includes(node.id);
    setProblem(null);
    setAnnouncement('');
    membersDone.current = `${member ? 'Removed from' : 'Added to'} ${branchLabel(branch, nodesById)}.`;
    await settleMembers(
      members.send(branch.id, {
        expectedRevision: branch.revision,
        ...(member ? { remove: [node.id] } : { add: [node.id] }),
      }),
    );
  }

  async function settleMembers(pendingOutcome: ReturnType<typeof members.send>) {
    const outcome = await pendingOutcome;
    if (!outcome) return;
    if (outcome.ok) {
      setAnnouncement(membersDone.current);
      return;
    }
    const said = membersProblem(outcome);
    if (said === 'locked') onLocked();
    // Nothing changed on the server: the refetched snapshot shows its state, silently.
    else if (said !== 'unchanged') setProblem({ ...said, from: 'members' });
  }

  async function start(retry = false) {
    if (pending) return;
    setProblem(null);
    setAnnouncement('');
    const outcome = await (retry
      ? starting.retry()
      : starting.send({ expectedRevision: studyRevision, rootNodeId: node.id }));
    if (!outcome) return;
    if (outcome.ok) {
      const created = outcome.value;
      // Starting a branch moved the study's revision: keep the cached study current.
      queryClient.setQueryData<StudyResponse>(studyQueryKey(studyId), (old) =>
        old && created.studyRevision > old.revision
          ? { ...old, revision: created.studyRevision }
          : old,
      );
      storeBranch(queryClient, studyId, created);
      focusBranch.current = created.id;
      void invalidateGraph(queryClient, studyId);
      void invalidateLibrary(queryClient);
      setAnnouncement(BRANCH_COPY.started);
      return;
    }
    const { error } = outcome;
    if (outcome.unknown) {
      setProblem({ text: BRANCH_COPY.unknown, retry: true, from: 'start' });
    } else if (isLifecycle(error)) {
      onLocked();
    } else if (statusOf(error) === 409) {
      void queryClient.invalidateQueries({ queryKey: studyQueryKey(studyId), exact: true });
      setProblem({ text: BRANCH_COPY.studyConflict, from: 'start' });
    } else {
      if (statusOf(error) === 404 || codeOf(error) === BRANCH_EXISTS) {
        void invalidateGraph(queryClient, studyId);
      }
      const text =
        statusOf(error) === 404
          ? BRANCH_COPY.gone
          : (branchRuleText(codeOf(error)) ?? BRANCH_COPY.failed);
      setProblem({ text, from: 'start' });
    }
  }

  const label = (branch: Branch) => branchLabel(branch, nodesById);

  return (
    <fieldset aria-labelledby={legendId} className="flex flex-col gap-3">
      <legend id={legendId} className="font-serif text-lg">
        Branches
      </legend>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {!branches ? (
        graph.isError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p>{BRANCH_COPY.loadFailed}</p>
            <button type="button" onClick={() => void graph.refetch()} className="underline">
              Retry
            </button>
          </div>
        ) : (
          <p role="status" className="text-muted">
            {BRANCH_COPY.loading}
          </p>
        )
      ) : branches.length === 0 ? (
        <p className="text-muted">{BRANCH_COPY.none}</p>
      ) : editable ? (
        <ul className="flex flex-col gap-2">
          {branches.map((branch) => {
            const isRoot = branch.rootNodeId === node.id;
            return (
              <li key={branch.id}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    ref={(element) => {
                      if (element) boxes.current.set(branch.id, element);
                      else boxes.current.delete(branch.id);
                    }}
                    checked={inBranch(branch, node.id)}
                    aria-disabled={isRoot || pending ? true : undefined}
                    onChange={() => void toggle(branch)}
                    className="mt-1 aria-disabled:opacity-60"
                  />
                  <span className="break-words">
                    {label(branch)}
                    {isRoot ? ' (root)' : ''}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <ReadOnlyBranches labels={branches.filter((b) => inBranch(b, node.id)).map(label)} />
      )}
      {problem ? (
        <ProblemLine
          problem={problem}
          onRetry={() =>
            void (problem.from === 'start' ? start(true) : settleMembers(members.retry()))
          }
        />
      ) : null}
      {canStart && branches ? (
        <div>
          <button
            type="button"
            aria-disabled={pending ? true : undefined}
            onClick={() => void start()}
            className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
          >
            Start a branch here
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function ReadOnlyBranches({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <p className="text-muted">{BRANCH_COPY.notInAny}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {labels.map((text, index) => (
        <li key={index} className="break-words">
          In {text}
        </li>
      ))}
    </ul>
  );
}
