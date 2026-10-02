'use client';

import { type Branch, BRANCH_UNCHANGED, type NodeSummary } from '@bible-artisan/contracts';
import { useId, useRef, useState } from 'react';
import { type Problem, ProblemLine } from '@/components/nodes/relationship-controls';
import { branchLabel, branchNodeIds } from '@/lib/branches';
import { useGraphViewStore } from '@/lib/graph-store';
import { MAX_ARRANGE_NODES } from '@/lib/graph-view';
import {
  BRANCH_COPY,
  branchRuleText,
  membersProblem,
  useBranchMembers,
} from './use-branch-members';

const count = (n: number) => n.toLocaleString('en-US');
const nodesText = (n: number) => `${count(n)} ${n === 1 ? 'node' : 'nodes'}`;

/**
 * The canvas toolbar's "Branches" disclosure (BIB-60): one row per branch, named by its root and
 * its node count in text, with Collapse and Show only (toggle buttons, `aria-pressed`; their state
 * is said in the row's text too, never by color alone) and Arrange (canvas only, editable and
 * wide; up to 100 nodes). On an editable study, "Add N selected to branch" adds the shared
 * selection to the chosen branch in one request. Collapse and Show only are presentation: nothing
 * stored changes and nothing is sent.
 */
export function BranchesMenu({
  studyId,
  branches,
  nodesById,
  live,
  soloBranchId,
  collapsedBranchIds,
  editable,
  movable,
  arrangeBlocked,
  arrangeInList,
  selectedNodeIds,
  onArrange,
  onAnnounce,
  onLocked,
}: {
  studyId: string;
  branches: readonly Branch[];
  nodesById: ReadonlyMap<string, NodeSummary>;
  /** The snapshot's live node ids. */
  live: ReadonlySet<string>;
  soloBranchId: string | null;
  collapsedBranchIds: readonly string[];
  editable: boolean;
  /** Arrange is offered (editable and wide, as for Arrange selection). */
  movable: boolean;
  /** List View is showing or a preview is open: Arrange waits. */
  arrangeBlocked: boolean;
  arrangeInList: boolean;
  selectedNodeIds: readonly string[];
  onArrange: (branch: Branch, opener: HTMLButtonElement) => void;
  onAnnounce: (text: string) => void;
  onLocked: () => void;
}) {
  const store = useGraphViewStore();
  const limitId = useId();
  const listReasonId = useId();
  const selectId = useId();
  const [target, setTarget] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const members = useBranchMembers(studyId);
  const label = (branch: Branch) => branchLabel(branch, nodesById);
  const chosen = branches.find((branch) => branch.id === target) ?? branches[0];
  const selected = selectedNodeIds.length;

  /**
   * The request in flight or held for Retry: the ids sent and the branch's members before (the
   * revision matched, so they are exact), to count what the server actually added.
   */
  const sent = useRef<{ ids: string[]; before: string[]; label: string } | null>(null);

  function settle(outcome: Awaited<ReturnType<typeof members.send>>) {
    const request = sent.current;
    if (!outcome || !request) return;
    if (outcome.ok) {
      const added = outcome.value.memberNodeIds.filter(
        (id) => request.ids.includes(id) && !request.before.includes(id),
      ).length;
      onAnnounce(`Added ${nodesText(added)} to ${request.label}.`);
      return;
    }
    const said = membersProblem(outcome);
    if (said === 'locked') onLocked();
    else if (said === 'unchanged') setProblem({ text: branchRuleText(BRANCH_UNCHANGED) ?? '' });
    else setProblem(said);
  }

  async function addSelected() {
    if (!chosen || selected === 0 || members.pending) return;
    setProblem(null);
    onAnnounce('');
    const ids = [...selectedNodeIds];
    sent.current = { ids, before: chosen.memberNodeIds, label: label(chosen) };
    settle(await members.send(chosen.id, { expectedRevision: chosen.revision, add: ids }));
  }

  async function retry() {
    setProblem(null);
    settle(await members.retry());
  }

  return (
    <details className="relative">
      <summary className="cursor-pointer rounded border border-muted px-2 py-1">Branches</summary>
      <div className="mt-2 flex max-w-[min(90vw,40rem)] flex-col gap-3 rounded border border-muted bg-canvas p-2">
        {branches.length === 0 ? (
          <p className="text-sm">{BRANCH_COPY.toolbarEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {branches.map((branch, index) => {
              const name = label(branch);
              const rowLimitId = `${limitId}-${index}`;
              const size = branchNodeIds(branch).filter((id) => live.has(id)).length;
              const collapsed = collapsedBranchIds.includes(branch.id);
              const solo = soloBranchId === branch.id;
              const tooMany = size > MAX_ARRANGE_NODES;
              const state = [collapsed ? 'collapsed' : '', solo ? 'shown alone' : '']
                .filter(Boolean)
                .join(', ');
              return (
                <li key={branch.id} className="flex flex-col gap-1">
                  <p className="break-words text-sm">
                    {name} ({nodesText(size)}){state ? ` · ${state}` : ''}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={collapsed}
                      onClick={() => store.getState().toggleCollapsed(branch.id)}
                      className="rounded border border-muted px-2 py-1 aria-pressed:border-2 aria-pressed:border-accent"
                    >
                      Collapse <span className="sr-only">{name}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={solo}
                      onClick={() => store.getState().setSoloBranch(solo ? null : branch.id)}
                      className="rounded border border-muted px-2 py-1 aria-pressed:border-2 aria-pressed:border-accent"
                    >
                      Show only <span className="sr-only">{name}</span>
                    </button>
                    {movable ? (
                      <>
                        <button
                          type="button"
                          disabled={arrangeBlocked || tooMany}
                          aria-describedby={
                            tooMany ? rowLimitId : arrangeInList ? listReasonId : undefined
                          }
                          onClick={(event) => onArrange(branch, event.currentTarget)}
                          className="rounded border border-muted px-2 py-1 disabled:opacity-50"
                        >
                          Arrange <span className="sr-only">{name}</span>
                        </button>
                        {tooMany ? (
                          <span id={rowLimitId} className="text-sm">
                            Arrange works on up to {MAX_ARRANGE_NODES} nodes.
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {movable && arrangeInList && branches.length > 0 ? (
          <p id={listReasonId} className="text-sm">
            Switch to Graph to preview an arrangement.
          </p>
        ) : null}
        {editable && branches.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              Add {count(selected)} selected to branch
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={selectId} className="text-sm">
                Branch
              </label>
              <select
                id={selectId}
                value={chosen?.id ?? ''}
                onChange={(event) => setTarget(event.target.value)}
                className="max-w-full rounded border border-muted bg-canvas px-2 py-1"
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {label(branch)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={selected === 0}
                aria-disabled={members.pending ? true : undefined}
                onClick={() => void addSelected()}
                className="rounded border border-accent px-2 py-1 text-accent disabled:opacity-50 aria-disabled:opacity-60"
              >
                Add
              </button>
            </div>
            {problem ? <ProblemLine problem={problem} onRetry={() => void retry()} /> : null}
          </fieldset>
        ) : null}
      </div>
    </details>
  );
}
