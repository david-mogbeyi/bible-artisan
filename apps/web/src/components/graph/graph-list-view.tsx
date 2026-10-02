'use client';

import {
  type GraphEdge,
  NODE_ORIGIN_NAMES,
  NODE_TYPE_NAMES,
  type NodeSummary,
} from '@bible-artisan/contracts';
import { type Ref, useId, useMemo } from 'react';
import { DUPLICATE_BADGE } from '@/components/nodes/nodes-section';
import { otherEnd, sentenceFrom } from '@/lib/edges';
import { nodeOptionText, nodeStateText } from '@/lib/nodes';
import { CONNECT_COPY } from './connect-dialog';

export const LIST_VIEW_COPY = {
  heading: 'Nodes and relationships',
  noneVisible: 'No nodes match the current view options.',
  noRelationships: 'No relationships.',
} as const;

/**
 * The graph as text (BIB-29, NFR-ACCESS-002): exactly the canvas's visible nodes, in snapshot
 * order, each with its type, origin, status or kind and Duplicate badge in words, and every live
 * relationship touching it as a sentence from its side (even when the other node is filtered
 * out). "Select" checkboxes edit the shared selection (the keyboard path to multi-select), "Open"
 * opens the node's detail (its edit form, and relationship edit and remove), "Show" opens the
 * other end of a relationship, and "Connect…" opens the Connect dialog from the node. Nothing here
 * drags, hovers or relies on position or color.
 */
export function GraphListView({
  nodes,
  edges,
  visible,
  selectedNodeIds,
  canConnect,
  headingRef,
  onToggle,
  onOpen,
  onConnect,
}: {
  /** The snapshot's live nodes, in its order. */
  nodes: readonly NodeSummary[];
  edges: readonly GraphEdge[];
  visible: ReadonlySet<string>;
  selectedNodeIds: readonly string[];
  /** An editable study: each row offers Connect…. */
  canConnect: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onToggle: (nodeId: string) => void;
  onOpen: (nodeId: string) => void;
  onConnect: (nodeId: string, opener: HTMLElement) => void;
}) {
  const headingId = useId();
  const loneId = useId();
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const touching = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    const add = (id: string, edge: GraphEdge) => {
      const list = map.get(id);
      if (list) list.push(edge);
      else map.set(id, [edge]);
    };
    for (const edge of edges) {
      add(edge.sourceNodeId, edge);
      add(edge.targetNodeId, edge);
    }
    return map;
  }, [edges]);
  const shown = nodes.filter((node) => visible.has(node.id));
  const selected = new Set(selectedNodeIds);
  const single = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  const alone = nodes.length < 2;
  const nameOf = (id: string) => {
    const node = byId.get(id);
    return node ? nodeOptionText(node) : 'another node in this study';
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="sr-only">
        {LIST_VIEW_COPY.heading}
      </h3>
      {shown.length === 0 ? (
        <p className="text-muted">{LIST_VIEW_COPY.noneVisible}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((node) => {
            const name = nodeOptionText(node);
            const state = nodeStateText(node);
            const related = touching.get(node.id) ?? [];
            const relatedId = `${headingId}-${node.id}`;
            return (
              <li key={node.id} className="flex flex-col gap-2 rounded border border-muted p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(node.id)}
                      onChange={() => onToggle(node.id)}
                    />
                    Select <span className="sr-only">{name}</span>
                  </label>
                  <button
                    type="button"
                    aria-pressed={single === node.id}
                    onClick={() => onOpen(node.id)}
                    className="flex min-w-0 flex-1 flex-col items-start rounded border border-muted px-3 py-2 text-left aria-pressed:border-2 aria-pressed:border-accent aria-pressed:font-semibold"
                  >
                    <span className="text-sm">
                      <span className="sr-only">Open</span> {NODE_TYPE_NAMES[node.type]} ·{' '}
                      {NODE_ORIGIN_NAMES[node.origin]}
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
                  {canConnect ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Connect ${name}…`}
                        aria-haspopup="dialog"
                        disabled={alone}
                        aria-describedby={alone ? loneId : undefined}
                        onClick={(event) => onConnect(node.id, event.currentTarget)}
                        className="rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
                      >
                        Connect…
                      </button>
                      {alone ? (
                        <p id={loneId} className="text-sm">
                          {CONNECT_COPY.noOther}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <p id={relatedId} className="text-sm font-medium">
                  Relationships ({related.length.toLocaleString('en-US')})
                </p>
                {related.length === 0 ? (
                  <p className="text-sm text-muted">{LIST_VIEW_COPY.noRelationships}</p>
                ) : (
                  <ul aria-labelledby={relatedId} className="flex flex-col gap-1 pl-4">
                    {related.map((edge) => {
                      const other = otherEnd(edge, node.id);
                      return (
                        <li key={edge.id} className="flex flex-wrap items-center gap-2">
                          <span className="break-words">
                            {sentenceFrom(edge, node, nameOf(other))}
                          </span>
                          <button
                            type="button"
                            aria-label={`Show ${nameOf(other)}`}
                            onClick={() => onOpen(other)}
                            className="underline"
                          >
                            Show
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
