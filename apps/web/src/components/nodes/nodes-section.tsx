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

const LOAD_COPY: ProblemCopy = {
  notFound: "This study's nodes aren't available.",
  refused: "Couldn't load the nodes.",
  unavailable: "Couldn't load the nodes.",
};

/**
 * The study's typed graph nodes (BIB-25) as a plain, keyboard-first list with one open node's
 * detail; the canvas (BIB-28) and the full List View (BIB-29) build on the same API later. Each
 * entry says its type, origin, and status or kind in words, never by color alone. An active
 * study can add nodes and edit observations, thoughts and sources; an archived or trashed one is
 * read-only. Node text appears only in the page, never in the URL or browser storage.
 */
export function NodesSection({
  study,
  onReload,
}: {
  study: StudyResponse;
  onReload: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The study revision a write was refused at for the study's lifecycle (BIB-22), if any. */
  const [lockedAt, setLockedAt] = useState<number | null>(null);
  const [focusDetail, setFocusDetail] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const returnToAdd = useRef(false);
  // Read-only until the study is reloaded (a reload brings a newer revision).
  const locked = lockedAt === study.revision;
  const editable = study.lifecycle === 'active' && !locked;
  const lock = () => setLockedAt(study.revision);

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
    setSelectedId(nodeId);
    setFocusDetail(focus);
  };
  const onFocused = useCallback(() => setFocusDetail(false), []);

  function cancelAdd() {
    returnToAdd.current = true;
    setAdding(false);
  }

  function created(node: CreateNodeResponse) {
    // Creating a node moved the study's revision: keep the cached study current.
    queryClient.setQueryData<StudyResponse>(studyQueryKey(study.id), (old) =>
      old && node.studyRevision > old.revision ? { ...old, revision: node.studyRevision } : old,
    );
    void queryClient.invalidateQueries({ queryKey: nodesQueryKey(study.id) });
    void invalidateLibrary(queryClient);
    setAdding(false);
    select(node.id, true);
    setAnnouncement(`${NODE_TYPE_NAMES[node.type]} added`);
  }

  const items = nodes.data?.items ?? [];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="font-serif text-2xl">
        {nodes.data ? `Nodes (${items.length.toLocaleString('en-US')})` : 'Nodes'}
      </h2>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {locked ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
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
          nodes={items}
          onCreated={created}
          onCancel={cancelAdd}
          onShow={(nodeId) => select(nodeId, true)}
          onLocked={lock}
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
                  aria-pressed={selectedId === node.id}
                  onClick={() => select(node.id, false)}
                  className="flex w-full flex-col items-start rounded border border-muted px-3 py-2 text-left aria-pressed:border-accent aria-pressed:font-semibold"
                >
                  <span className="text-sm">
                    {NODE_TYPE_NAMES[node.type]} · {NODE_ORIGIN_NAMES[node.origin]}
                    {state ? ` · ${state}` : ''}
                  </span>{' '}
                  <span className="break-words">{node.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedId ? (
        <NodeDetail
          key={selectedId}
          studyId={study.id}
          nodeId={selectedId}
          editable={editable}
          focusOnLoad={focusDetail}
          onFocused={onFocused}
          onSaved={() => setAnnouncement('Saved')}
          onLocked={lock}
        />
      ) : null}
    </section>
  );
}
