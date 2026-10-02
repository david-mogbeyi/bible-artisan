'use client';

import { NODE_ORIGIN_NAMES, NODE_TYPE_NAMES, type StudyNodeType } from '@bible-artisan/contracts';
import { Handle, type NodeProps, Position, useStore } from '@xyflow/react';
import { memo } from 'react';
import type { GraphFlowNode } from '@/lib/graph-view';
import { nodeStateText } from '@/lib/nodes';

/** A decorative glyph per type; the type's name is always written next to it. */
const TYPE_ICONS: Record<StudyNodeType, string> = {
  scripture: '¶',
  question: '?',
  observation: '◉',
  thought: '~',
  conclusion: '✓',
  source: '§',
};

/** True below 50% zoom: a boolean, so zooming re-renders a node only when it crosses the line. */
const compactSelector = (state: { transform: [number, number, number] }) =>
  state.transform[2] < 0.5;

/**
 * One study node on the canvas (BIB-28), memoized: it re-renders only when its data object (built
 * once per snapshot), its selection or the 50% zoom line changes. Everything is text: type, label,
 * origin, status or kind, "Duplicate", "Branch root" and "Selected", never color or position
 * alone. Below 50% zoom only the type, label and status show (PRD section 12). Handles exist only
 * so edges can attach; nothing is connectable here (drag-to-connect is BIB-29's).
 */
function GraphNodeComponent({ data, selected }: NodeProps<GraphFlowNode>) {
  const compact = useStore(compactSelector);
  const { summary, branchRoot } = data;
  const state = nodeStateText(summary);
  return (
    <div
      className={`flex h-full w-full flex-col gap-1 overflow-hidden rounded border bg-canvas px-2 py-1 text-left text-xs ${
        selected ? 'border-2 border-accent' : 'border-ink'
      }`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="opacity-0" />
      <p className="flex flex-wrap items-center gap-1 font-medium">
        <span aria-hidden="true">{TYPE_ICONS[summary.type]}</span>
        <span>{NODE_TYPE_NAMES[summary.type]}</span>
        {!compact ? (
          <span className="text-muted">· {NODE_ORIGIN_NAMES[summary.origin]}</span>
        ) : null}
        {state ? <span>· {state}</span> : null}
      </p>
      <p className="line-clamp-2 break-words">{summary.label}</p>
      {!compact ? (
        <p className="flex flex-wrap gap-1">
          {summary.canonicalNodeId ? <span className="rounded border px-1">Duplicate</span> : null}
          {branchRoot ? <span className="rounded border px-1">Branch root</span> : null}
          {selected ? <span className="rounded border border-accent px-1">Selected</span> : null}
        </p>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="opacity-0"
      />
    </div>
  );
}

export const GraphNode = memo(GraphNodeComponent);

/** Stable for React Flow (a new object each render would remount every node). */
export const NODE_TYPES = { study: GraphNode };
