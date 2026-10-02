import type { StudyResponse } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodesSection } from '@/components/nodes/nodes-section';
import { nodeAccessibleName } from '@/lib/graph-view';
import { nodeOptionText } from '@/lib/nodes';
import { expectNoA11yViolations } from '@/test/axe';
import { C, D, NODES, O, Q, S, STUDY, stubGraphApi } from '@/test/graph-fixtures';
import { renderWithQuery, textOf } from '@/test/render';
import { CONNECT_COPY } from './connect-dialog';
import { GRAPH_COPY, GraphSection } from './graph-section';
import { LIST_VIEW_COPY } from './graph-list-view';

let api: ReturnType<typeof stubGraphApi>;

beforeEach(() => {
  api = stubGraphApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

/** "Question: What is conscience?": how List View and the Connect dialog name a node. */
const name = (id: string) => {
  const node = NODES.find((n) => n.id === id);
  if (!node) throw new Error('unknown node');
  return nodeOptionText(node);
};
const checkbox = (id: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `Select ${name(id)}` });
/** A List View row: the node's item, found by its Select checkbox. */
const row = (id: string) => checkbox(id).closest('li') as HTMLElement;
const sentences = (id: string) =>
  within(row(id))
    .queryAllByRole('listitem')
    .map((item) => textOf(item.querySelector('span')));
const status = () => screen.getByText(/^Showing \d+ of \d+ nodes/);
const listHeading = () => screen.getByRole('heading', { name: LIST_VIEW_COPY.heading });
const canvas = () => screen.getByRole('group', { name: 'Study graph' });
/** A canvas node by its accessible name (type, label and status). */
const canvasNode = (id: string) =>
  within(canvas()).getByRole('group', {
    name: nodeAccessibleName(NODES.find((n) => n.id === id) as (typeof NODES)[number]),
  });

async function openPage(study: StudyResponse = STUDY, { list = true } = {}) {
  const view = renderWithQuery(
    <>
      <GraphSection study={study} />
      <NodesSection study={study} onReload={() => Promise.resolve()} />
    </>,
  );
  if (list) {
    fireEvent.click(await screen.findByRole('button', { name: 'List', pressed: false }));
    await screen.findByRole('heading', { name: LIST_VIEW_COPY.heading });
  } else {
    await screen.findByRole('group', { name: 'Study graph' });
  }
  return view;
}

describe('Graph List View (BIB-29)', () => {
  it("reads every visible node's type, origin, status or kind and Duplicate badge, and each relationship as a sentence from its side", async () => {
    await openPage();
    // The switch is announced.
    expect(screen.getByText('List view')).toBeTruthy();
    const open = (id: string) => within(row(id)).getByRole('button', { name: /^Open / });
    expect(textOf(open(Q))).toBe('Open Question · You · Open What is conscience?');
    expect(textOf(open(O))).toBe(
      'Open Observation · You · Textual observation Paul appeals to conscience',
    );
    expect(textOf(open(D))).toBe('Open Scripture · Scripture Text · Duplicate Romans 9:1');
    expect(textOf(open(C))).toBe('Open Source · External Source A commentary');

    expect(textOf(row(O))).toContain('Relationships (2)');
    expect(sentences(O)).toStrictEqual([
      'This observation supports Question: What is conscience?',
      'This observation is related to Source: A commentary',
    ]);
    // Incoming reads with the same verb, the other node first; a two-way type reads the same.
    expect(sentences(Q)).toStrictEqual([
      'Observation: Paul appeals to conscience supports this question',
    ]);
    expect(sentences(C)).toStrictEqual([
      'This source is related to Observation: Paul appeals to conscience',
    ]);
    expect(textOf(row(S))).toContain(LIST_VIEW_COPY.noRelationships);
    // Nodes in snapshot order.
    const order = screen
      .getAllByRole('checkbox', { name: /^Select / })
      .map((box) => textOf(box.closest('label')));
    expect(order).toStrictEqual(NODES.map((n) => `Select ${name(n.id)}`));
  });

  it("lists exactly the canvas's visible set under the same summary line, keeps a relationship to a filtered node, and changes nothing stored", async () => {
    await openPage(STUDY, { list: false });
    fireEvent.click(screen.getByRole('button', { name: 'Sources', pressed: true }));
    const onCanvas = NODES.filter((n) =>
      within(canvas()).queryByRole('group', { name: nodeAccessibleName(n) }),
    ).map((n) => n.id);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(textOf(status())).toBe('Showing 4 of 5 nodes · 1 hidden by filters');
    const listed = screen
      .getAllByRole('checkbox', { name: /^Select / })
      .map((box) => NODES.find((n) => box === checkbox(n.id))?.id);
    expect(listed).toStrictEqual(onCanvas);
    expect(screen.queryByRole('checkbox', { name: `Select ${name(C)}` })).toBeNull();
    expect(sentences(O)).toContain('This observation is related to Source: A commentary');

    // Focus around the question: the observation is one hop away, everything else hidden.
    fireEvent.click(within(row(Q)).getByRole('button', { name: /^Open / }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(textOf(status())).toContain('Showing 2 of 5 nodes');
    expect(
      screen.getAllByRole('checkbox', { name: /^Select / }).map((box) => box.closest('li')),
    ).toStrictEqual([row(Q), row(O)]);
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));

    for (const type of ['Question', 'Observation', 'Scripture']) {
      fireEvent.click(screen.getByRole('checkbox', { name: type }));
    }
    expect(screen.getByText(LIST_VIEW_COPY.noneVisible)).toBeTruthy();
    expect(textOf(status())).toBe('Showing 0 of 5 nodes · 5 hidden by filters · 1 selected');
    expect(api.mutations()).toStrictEqual([]);
    // Switching views reads nothing again.
    expect(api.graphReads).toBe(1);
  });

  it('shares the selection with the canvas both ways, and the Select checkboxes enable Connect… and Arrange selection', async () => {
    await openPage();
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect…' });
    expect(connect.disabled).toBe(true);
    expect(textOf(document.getElementById(connect.getAttribute('aria-describedby') ?? ''))).toBe(
      GRAPH_COPY.selectToConnect,
    );
    fireEvent.click(checkbox(Q));
    fireEvent.click(checkbox(O));
    expect(textOf(status())).toContain('2 selected');
    expect(connect.disabled).toBe(false);
    // Arrangement previews are drawn on the canvas.
    const arrange = screen.getByRole<HTMLButtonElement>('button', { name: 'Arrange selection' });
    expect(arrange.disabled).toBe(true);
    expect(textOf(document.getElementById(arrange.getAttribute('aria-describedby') ?? ''))).toBe(
      GRAPH_COPY.arrangeInList,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.getByText('Graph view')).toBeTruthy();
    expect(textOf(canvasNode(Q))).toContain('Selected');
    expect(textOf(canvasNode(O))).toContain('Selected');
    expect(textOf(canvasNode(S))).not.toContain('Selected');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Arrange selection' }).disabled,
    ).toBe(false);

    // And back: a canvas selection is what List View shows.
    fireEvent.click(canvasNode(C));
    await waitFor(() => expect(textOf(status())).toContain('1 selected'));
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(checkbox(C).checked).toBe(true);
    expect(checkbox(Q).checked).toBe(false);
    expect(checkbox(O).checked).toBe(false);
  });

  it("Open selects only that node and focuses its detail's heading; Show opens the other end", async () => {
    await openPage();
    fireEvent.click(checkbox(S));
    const open = within(row(O)).getByRole('button', { name: /^Open / });
    fireEvent.click(open);
    const heading = await screen.findByRole('heading', { name: 'Observation' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(open.getAttribute('aria-pressed')).toBe('true');
    expect(checkbox(S).checked).toBe(false);

    fireEvent.click(within(row(O)).getByRole('button', { name: `Show ${name(Q)}` }));
    const question = await screen.findByRole('heading', { name: 'Question' });
    await waitFor(() => expect(document.activeElement).toBe(question));
    expect(checkbox(Q).checked).toBe(true);
  });

  it('steps Back and Forward through selected nodes, keeps focus on the button, and sends nothing', async () => {
    await openPage();
    const back = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Back to previously selected node',
    });
    const forward = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Forward to next selected node',
    });
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
    for (const id of [Q, O, C]) {
      fireEvent.click(within(row(id)).getByRole('button', { name: /^Open / }));
    }
    expect(await screen.findByRole('heading', { name: 'Source' })).toBeTruthy();

    back.focus();
    fireEvent.click(back);
    expect(await screen.findByRole('heading', { name: 'Observation' })).toBeTruthy();
    expect(screen.getByText(`Selected ${name(O)}`)).toBeTruthy();
    fireEvent.click(back);
    expect(await screen.findByRole('heading', { name: 'Question' })).toBeTruthy();
    expect(back.disabled).toBe(true);
    forward.focus();
    fireEvent.click(forward);
    expect(await screen.findByRole('heading', { name: 'Observation' })).toBeTruthy();
    expect(document.activeElement).toBe(forward);

    // Multi-select neither adds an entry nor drops the forward ones.
    fireEvent.click(checkbox(S));
    expect(forward.disabled).toBe(false);
    fireEvent.click(checkbox(S));

    fireEvent.click(within(row(D)).getByRole('button', { name: /^Open / }));
    expect(await screen.findByRole('heading', { name: 'Scripture' })).toBeTruthy();
    expect(forward.disabled).toBe(true);
    expect(back.disabled).toBe(false);
    expect(api.mutations()).toStrictEqual([]);
  });

  it('keeps List View, selection and Back / Forward on an archived study, with no Connect anywhere', async () => {
    await openPage({ ...STUDY, lifecycle: 'archived' });
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
    fireEvent.click(checkbox(Q));
    expect(textOf(status())).toContain('1 selected');
    fireEvent.click(within(row(O)).getByRole('button', { name: /^Open / }));
    expect(await screen.findByRole('heading', { name: 'Observation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to previously selected node' }));
    expect(await screen.findByRole('heading', { name: 'Question' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
  });

  it('starts in List View below 900 px, with Connect… still offered', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    renderWithQuery(<GraphSection study={STUDY} />);
    expect(await screen.findByRole('button', { name: 'List', pressed: true })).toBeTruthy();
    expect(listHeading()).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Study graph' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Arrange selection' })).toBeNull();
    fireEvent.click(checkbox(O));
    fireEvent.click(screen.getByRole('button', { name: 'Connect…' }));
    expect(screen.getByRole('dialog', { name: CONNECT_COPY.title })).toBeTruthy();
  });

  it('has no axe violations in List View or the toolbar', async () => {
    await openPage();
    fireEvent.click(checkbox(Q));
    await expectNoA11yViolations(screen.getByRole('region', { name: 'Graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await expectNoA11yViolations(screen.getByRole('toolbar', { name: 'Graph tools' }));
  });
});
