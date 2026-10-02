'use client';

import {
  type CreateNodeResponse,
  NODE_ORIGIN_NAMES,
  NODE_TYPE_NAMES,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import {
  addProblemText,
  isLifecycleRefusal,
  NODE_ADD_COPY,
  outcomeText,
  scriptureRequest,
  useAddNode,
} from '@/lib/add-node';
import { invalidateGraph } from '@/lib/graph';
import { useGraphView, useGraphViewStore } from '@/lib/graph-store';
import { listNodes, nodeStateText, nodesQueryKey } from '@/lib/nodes';
import { invalidateLibrary, studyQueryKey } from '@/lib/studies';
import { AddNodeForm } from './add-node-form';
import { NodeDetail } from './node-detail';

export const NODES_COPY = {
  loading: 'Loading nodes…',
  empty: 'No nodes yet. Add a passage, question, observation, thought, conclusion or source.',
  readOnly: 'This study is read-only, so its nodes are too.',
  locked:
    'This study was archived or moved to the trash somewhere else, so nothing was saved. Reload to see it.',
} as const;

/** "Duplicate", the text badge a deliberate duplicate Scripture node carries (never color alone). */
export const DUPLICATE_BADGE = 'Duplicate';

/** A passage the study already held, focused instead of added again. */
interface Revisit {
  /** The focused existing node: the status shows only while it is the selected one. */
  nodeId: string;
  referenceId: string;
  label: string;
  /** The study revision the focus moved to: a copy is requested from at least this one. */
  studyRevision: number;
}

const LOAD_COPY: ProblemCopy = {
  notFound: "This study's nodes aren't available.",
  refused: "Couldn't load the nodes.",
  unavailable: "Couldn't load the nodes.",
};

/**
 * The study's typed graph nodes (BIB-25) as a plain, keyboard-first list with one open node's
 * detail; the canvas (BIB-28) shares its selection, and the full List View (BIB-29) builds on the
 * same API later. Each
 * entry says its type, origin, and status or kind in words, never by color alone. An active
 * study can add nodes and edit observations, thoughts and sources; an archived or trashed one is
 * read-only. Node text appears only in the page, never in the URL or browser storage.
 *
 * BIB-26: adding a passage the study already holds selects its node and says so, with "Add a
 * separate copy" for a deliberate duplicate; duplicates carry a "Duplicate" text badge. The page's
 * `?node=<id>` (an opaque id only) selects that node once the list has it, else is ignored.
 */
export function NodesSection({
  study,
  onReload,
  initialNodeId = null,
}: {
  study: StudyResponse;
  onReload: () => Promise<unknown>;
  /** From the page URL's `?node=`: untrusted, selected only if it is one of the listed nodes. */
  initialNodeId?: string | null;
}) {
  const queryClient = useQueryClient();
  const headingId = useId();
  // Shared with the canvas (BIB-28): the last selected node is the one whose detail is open.
  const graphView = useGraphViewStore();
  const selectedId = useGraphView((s) => s.selectedNodeIds.at(-1) ?? null);
  const selectionSource = useGraphView((s) => s.selectionSource);
  const [adding, setAdding] = useState(false);
  /** The study revision a write was refused at for the study's lifecycle (BIB-22), if any. */
  const [lockedAt, setLockedAt] = useState<number | null>(null);
  // Focus the `?node=` node's heading when it opens (the user came to see it).
  const [focusDetail, setFocusDetail] = useState(initialNodeId !== null);
  const [announcement, setAnnouncement] = useState('');
  const [revisit, setRevisit] = useState<Revisit | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnToAdd = useRef(false);
  const lockedAlert = useRef<HTMLDivElement>(null);
  const focusLockedAlert = useRef(false);
  // Read-only until the study is reloaded (a reload brings a newer revision).
  const locked = lockedAt === study.revision;
  const editable = study.lifecycle === 'active' && !locked;
  const lock = () => setLockedAt(study.revision);
  /**
   * A lifecycle refusal from an add control that unmounts with it (the Add node form, "Add a
   * separate copy"): the section-level alert says why and takes focus, so focus is never dropped.
   */
  const lockFromAdd = () => {
    focusLockedAlert.current = true;
    lock();
  };

  useEffect(() => {
    if (!locked || !focusLockedAlert.current) return;
    focusLockedAlert.current = false;
    lockedAlert.current?.focus();
  }, [locked]);

  const nodes = useQuery({
    queryKey: nodesQueryKey(study.id),
    queryFn: () => listNodes(study.id),
  });

  useEffect(() => {
    if (adding || !returnToAdd.current) return;
    returnToAdd.current = false;
    addButton.current?.focus();
  }, [adding]);

  const select = (nodeId: string, focus: boolean) => {
    graphView.getState().select([nodeId], 'list');
    setFocusDetail(focus);
    // The revisit status is about the node it focused: another node drops it.
    setRevisit((current) => (current && current.nodeId !== nodeId ? null : current));
  };
  const onFocused = useCallback(() => setFocusDetail(false), []);

  function cancelAdd() {
    returnToAdd.current = true;
    setAdding(false);
  }

  function created(node: CreateNodeResponse, label: string | null) {
    // Every outcome moved the study's revision: keep the cached study current.
    queryClient.setQueryData<StudyResponse>(studyQueryKey(study.id), (old) =>
      old && node.studyRevision > old.revision ? { ...old, revision: node.studyRevision } : old,
    );
    void queryClient.invalidateQueries({ queryKey: nodesQueryKey(study.id) });
    void invalidateGraph(queryClient, study.id);
    void invalidateLibrary(queryClient);
    setAdding(false);
    select(node.id, true);
    const passage = label ?? 'This passage';
    if (node.outcome === 'focused_existing' && node.referenceId) {
      // Announced in the section's live region (a newly mounted one may go unread) and shown
      // below with "Add a separate copy".
      setAnnouncement(outcomeText(node, passage));
      setRevisit({
        nodeId: node.id,
        referenceId: node.referenceId,
        label: passage,
        studyRevision: node.studyRevision,
      });
      return;
    }
    setRevisit(null);
    setAnnouncement(
      node.type === 'scripture' && label
        ? outcomeText(node, label)
        : `${NODE_TYPE_NAMES[node.type]} added`,
    );
  }

  const items = nodes.data?.items ?? [];
  // Until the user picks a node, the `?node=` one is selected once the list has it.
  const shownId =
    selectedId ?? (items.some((node) => node.id === initialNodeId) ? initialNodeId : null);
  const labelOf = (nodeId: string) => items.find((node) => node.id === nodeId)?.label ?? null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="font-serif text-2xl">
        {nodes.data ? `Nodes (${items.length.toLocaleString('en-US')})` : 'Nodes'}
      </h2>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {locked ? (
        <div
          role="alert"
          ref={lockedAlert}
          tabIndex={-1}
          className="flex flex-wrap items-center gap-3"
        >
          <p>{NODES_COPY.locked}</p>
          <button type="button" onClick={() => void onReload()} className="underline">
            Reload
          </button>
        </div>
      ) : !editable ? (
        <p className="text-muted">{NODES_COPY.readOnly}</p>
      ) : null}

      {editable && !adding ? (
        <div>
          <button
            type="button"
            ref={addButton}
            onClick={() => {
              setAnnouncement('');
              setRevisit(null);
              setAdding(true);
            }}
            className="rounded border border-accent px-3 py-1 text-accent"
          >
            Add node
          </button>
        </div>
      ) : null}
      {editable && adding ? (
        <AddNodeForm
          study={study}
          onCreated={created}
          onCancel={cancelAdd}
          onLocked={lockFromAdd}
          onReload={onReload}
        />
      ) : null}
      {editable && revisit && revisit.nodeId === shownId ? (
        <RevisitStatus
          key={`revisit:${revisit.nodeId}`}
          study={study}
          revisit={revisit}
          onCreated={(node) => created(node, revisit.label)}
          onLocked={lockFromAdd}
          onReload={onReload}
        />
      ) : null}

      {nodes.isError ? (
        <ProblemAlert error={nodes.error} copy={LOAD_COPY} onRetry={() => void nodes.refetch()} />
      ) : !nodes.data ? (
        <p role="status" className="text-muted">
          {NODES_COPY.loading}
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted">{NODES_COPY.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((node) => {
            const state = nodeStateText(node);
            return (
              <li key={node.id}>
                <button
                  type="button"
                  aria-pressed={shownId === node.id}
                  onClick={() => select(node.id, false)}
                  className="flex w-full flex-col items-start rounded border border-muted px-3 py-2 text-left aria-pressed:border-accent aria-pressed:font-semibold"
                >
                  <span className="text-sm">
                    {NODE_TYPE_NAMES[node.type]} · {NODE_ORIGIN_NAMES[node.origin]}
                    {state ? ` · ${state}` : ''}
                    {node.canonicalNodeId ? (
                      <>
                        {' · '}
                        <span className="rounded border border-ink px-1">{DUPLICATE_BADGE}</span>
                      </>
                    ) : null}
                  </span>{' '}
                  <span className="break-words">{node.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {shownId ? (
        <NodeDetail
          key={shownId}
          studyId={study.id}
          nodeId={shownId}
          editable={editable}
          // A node picked on the canvas opens without taking focus from the canvas.
          focusOnLoad={focusDetail && (selectedId === null || selectionSource === 'list')}
          onFocused={onFocused}
          onSaved={() => setAnnouncement('Saved')}
          onLocked={lock}
          labelOf={labelOf}
          onShowNode={(nodeId) => select(nodeId, true)}
          nodes={items}
          studyRevision={study.revision}
          onReload={onReload}
        />
      ) : null}
    </section>
  );
}

/**
 * The passage was already in the study, so its node was selected (BIB-26). Says so and offers a
 * deliberate duplicate: the same Add with `explicit_duplicate` through `useAddNode`, a new request
 * on the study's current revision with its own Idempotency-Key, which Retry resends verbatim after
 * an unknown outcome. A lifecycle refusal hands over to the section's alert (`onLocked`).
 */
function RevisitStatus({
  study,
  revisit,
  onCreated,
  onLocked,
  onReload,
}: {
  study: StudyResponse;
  revisit: Revisit;
  onCreated: (created: CreateNodeResponse) => void;
  onLocked: () => void;
  onReload: () => Promise<unknown>;
}) {
  const add = useAddNode(study.id);
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);

  async function addCopy(retry = false) {
    const request = retry
      ? add.retry()
      : add.send(
          scriptureRequest(
            revisit.referenceId,
            Math.max(study.revision, revisit.studyRevision),
            'explicit_duplicate',
          ),
          null,
        );
    if (!request) return;
    setProblem(null);
    const result = await request;
    if (result.ok) {
      onCreated(result.node);
      return;
    }
    const { problem: reason } = result;
    if (isLifecycleRefusal(reason)) {
      onLocked();
      return;
    }
    if (reason.kind === 'conflict') void onReload();
    setProblem({
      text: addProblemText(reason, NODE_ADD_COPY.separateCopy),
      retry: reason.kind === 'unknown',
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <p>{NODE_ADD_COPY.focused(revisit.label)}</p>
        <button
          type="button"
          aria-disabled={add.pending ? true : undefined}
          onClick={() => void addCopy()}
          className="rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60"
        >
          {NODE_ADD_COPY.separateCopy}
        </button>
      </div>
      {problem ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{problem.text}</p>
          {problem.retry ? (
            <button type="button" onClick={() => void addCopy(true)} className="underline">
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
