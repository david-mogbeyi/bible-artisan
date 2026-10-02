import type { StudyResponse } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type * as Flow from '@xyflow/react';
import type { ReactFlowProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeOptionText } from '@/lib/nodes';
import { createdEdge, NODES, O, Q, STUDY, stubGraphApi } from '@/test/graph-fixtures';
import { renderWithQuery } from '@/test/render';
import { CONNECT_COPY } from './connect-dialog';
import { GRAPH_COPY, GraphSection } from './graph-section';
import { LIST_VIEW_COPY } from './graph-list-view';

/**
 * The canvas's drag-to-connect and error boundary (BIB-29). jsdom cannot drag between handles, so
 * React Flow is wrapped to capture the props the canvas gives it (and to fail on request).
 */
const flow = vi.hoisted(() => ({
  props: null as ReactFlowProps | null,
  fail: false,
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof Flow>();
  function CapturingReactFlow(props: ReactFlowProps) {
    if (flow.fail) throw new Error('canvas failed');
    flow.props = props;
    return <actual.ReactFlow {...props} />;
  }
  return { ...actual, ReactFlow: CapturingReactFlow };
});

let api: ReturnType<typeof stubGraphApi>;

beforeEach(() => {
  api = stubGraphApi();
  flow.props = null;
  flow.fail = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const name = (id: string) =>
  nodeOptionText(NODES.find((n) => n.id === id) as (typeof NODES)[number]);
const field = (label: string) =>
  within(screen.getByRole('dialog', { name: CONNECT_COPY.title })).getByRole<HTMLSelectElement>(
    'combobox',
    { name: label },
  );
const connectableHandles = () => document.querySelectorAll('.react-flow__handle.connectable');

async function openCanvas(study: StudyResponse = STUDY) {
  renderWithQuery(<GraphSection study={study} />);
  await screen.findByRole('group', { name: 'Study graph' });
}

function drop(source: string, target: string) {
  act(() => flow.props?.onConnect?.({ source, target, sourceHandle: null, targetHandle: null }));
}

describe('Canvas drag-to-connect (BIB-29)', () => {
  it('opens the Connect dialog from a handle drop, prefilled and untyped, and saves nothing until Connect', async () => {
    await openCanvas();
    expect(flow.props?.nodesConnectable).toBe(true);
    expect(connectableHandles().length).toBeGreaterThan(0);
    drop(O, Q);
    expect(field('From').value).toBe(O);
    expect(field('To').value).toBe(Q);
    expect(field('Relationship').value).toBe('');
    expect(document.activeElement).toBe(field('Relationship'));
    expect(api.mutations()).toStrictEqual([]);
    // The canvas's edges are only ever the snapshot's.
    expect(flow.props?.edges).toHaveLength(2);

    fireEvent.change(field('Relationship'), { target: { value: 'explains' } });
    api.edgeReplies.push(createdEdge(O, Q, 'explains'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.mutations()).toHaveLength(1);
    // Focus returns to the node the drag started from.
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(new RegExp(`^${name(O)}`));
  });

  it('refuses a drop on the node it started from', async () => {
    await openCanvas();
    const valid = flow.props?.isValidConnection;
    expect(valid?.({ source: O, target: O, sourceHandle: null, targetHandle: null })).toBe(false);
    expect(valid?.({ source: O, target: Q, sourceHandle: null, targetHandle: null })).toBe(true);
    drop(O, O);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no connectable handles or Connect control on a read-only study', async () => {
    await openCanvas({ ...STUDY, lifecycle: 'trashed' });
    expect(flow.props?.nodesConnectable).toBe(false);
    expect(connectableHandles()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
  });

  it('has no connectable handles below 900 px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    renderWithQuery(<GraphSection study={STUDY} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Graph', pressed: false }));
    await screen.findByRole('group', { name: 'Study graph' });
    expect(flow.props?.nodesConnectable).toBe(false);
    expect(connectableHandles()).toHaveLength(0);
  });

  it('offers List View when the canvas cannot be drawn, and focuses it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    flow.fail = true;
    renderWithQuery(<GraphSection study={STUDY} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(GRAPH_COPY.drawFailed);
    fireEvent.click(screen.getByRole('button', { name: 'Open List View' }));
    const heading = await screen.findByRole('heading', { name: LIST_VIEW_COPY.heading });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole('button', { name: 'List', pressed: true })).toBeTruthy();
  });
});
