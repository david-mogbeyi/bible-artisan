import type { StudyResponse } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_RULE_COPY } from '@/components/nodes/relationship-controls';
import { edgesQueryKey } from '@/lib/edges';
import { graphQueryKey } from '@/lib/graph';
import { nodeOptionText } from '@/lib/nodes';
import { studyQueryKey } from '@/lib/studies';
import { expectNoA11yViolations } from '@/test/axe';
import {
  createdEdge,
  envelope,
  GRAPH,
  NODES,
  O,
  Q,
  S,
  STUDY,
  STUDY_ID,
  stubGraphApi,
} from '@/test/graph-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { CONNECT_COPY } from './connect-dialog';
import { GRAPH_COPY, GraphSection } from './graph-section';

let api: ReturnType<typeof stubGraphApi>;

beforeEach(() => {
  api = stubGraphApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EDGES = `/studies/${STUDY_ID}/edges`;
const name = (id: string) =>
  nodeOptionText(NODES.find((n) => n.id === id) as (typeof NODES)[number]);
const dialog = () => screen.getByRole('dialog', { name: CONNECT_COPY.title });
const field = (label: string) =>
  within(dialog()).getByRole<HTMLSelectElement>('combobox', { name: label });
const options = (label: string) =>
  within(field(label))
    .getAllByRole<HTMLOptionElement>('option')
    .map((option) => option.value);
const announcement = () =>
  textOf(screen.getAllByRole('status').find((el) => el.className === 'sr-only'));
const rowConnect = (id: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `Connect ${name(id)}…` });

/** The Graph section in List View, editable unless `study` says otherwise. */
async function openList(study: StudyResponse = STUDY) {
  const view = renderWithQuery(<GraphSection study={study} />);
  fireEvent.click(await screen.findByRole('button', { name: 'List', pressed: false }));
  return view;
}

describe('Connect dialog (BIB-29)', () => {
  it('connects from a List View row by keyboard: From prefilled, type and To chosen, Swap, the exact POST, then "Relationship added." with focus back on the row', async () => {
    const { queryClient } = await openList();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const opener = rowConnect(S);
    fireEvent.click(opener);
    expect(field('From').value).toBe(S);
    // Relationship is the first field left to fill, and is never prefilled.
    expect(document.activeElement).toBe(field('Relationship'));
    expect(field('Relationship').value).toBe('');
    expect(field('To').value).toBe('');
    expect(dialog().querySelector('optgroup[label="More relationships"]')).not.toBeNull();

    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    const preview = within(dialog()).getByText(/ supports /);
    expect(preview.getAttribute('aria-live')).toBe('polite');
    expect(textOf(preview)).toBe(`${name(S)} supports ${name(O)}`);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Swap direction' }));
    expect(field('From').value).toBe(O);
    expect(textOf(preview)).toBe(`${name(O)} supports ${name(S)}`);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Swap direction' }));

    api.edgeReplies.push(createdEdge(S, O, 'supports'));
    api.graph = {
      ...GRAPH,
      edges: [
        ...GRAPH.edges,
        {
          id: 'e9000000-2222-4333-8444-555555555555',
          sourceNodeId: S,
          targetNodeId: O,
          type: 'supports',
          origin: 'user',
        },
      ],
    };
    // Nothing optimistic: the row has no relationship until the server says so.
    const scriptureRow = screen
      .getByRole('checkbox', { name: `Select ${name(S)}` })
      .closest('li') as HTMLElement;
    expect(textOf(scriptureRow)).toContain('Relationships (0)');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(announcement()).toBe(CONNECT_COPY.added);
    expect(document.activeElement).toBe(opener);
    expect(api.mutations()).toStrictEqual([
      {
        method: 'POST',
        path: EDGES,
        body: { expectedRevision: 4, sourceNodeId: S, targetNodeId: O, type: 'supports' },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      },
    ]);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        edgesQueryKey(STUDY_ID, S),
        edgesQueryKey(STUDY_ID, O),
        studyQueryKey(STUDY_ID),
        graphQueryKey(STUDY_ID),
      ]),
    );
    await waitFor(() => expect(textOf(scriptureRow)).toContain('Relationships (1)'));
    expect(textOf(scriptureRow)).toContain(`This scripture supports ${name(O)}`);
  });

  it('never offers the same node at both ends', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    expect(options('To')).not.toContain(S);
    fireEvent.change(field('To'), { target: { value: O } });
    expect(options('From')).not.toContain(O);
    expect(options('From')).toContain(S);
  });

  it('hides Swap direction for a two-way type and says the nodes are related both ways', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'parallels' } });
    fireEvent.change(field('To'), { target: { value: Q } });
    expect(within(dialog()).queryByRole('button', { name: 'Swap direction' })).toBeNull();
    expect(within(dialog()).getByText(`${name(S)} parallels ${name(Q)}`)).toBeTruthy();
  });

  it('checks the fields before sending: each missing choice is said next to its field', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    const type = field('Relationship');
    expect(type.getAttribute('aria-invalid')).toBe('true');
    expect(textOf(document.getElementById(type.getAttribute('aria-describedby') ?? ''))).toBe(
      CONNECT_COPY.needType,
    );
    const to = field('To');
    expect(textOf(document.getElementById(to.getAttribute('aria-describedby') ?? ''))).toBe(
      CONNECT_COPY.needTo,
    );
    expect(document.activeElement).toBe(type);
    expect(api.mutations()).toStrictEqual([]);
  });

  it('keeps the dialog and draft open when the relationship already exists', async () => {
    await openList();
    fireEvent.click(rowConnect(O));
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: Q } });
    const note = within(dialog()).getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Note (optional)',
    });
    fireEvent.change(note, { target: { value: 'My draft' } });
    api.edgeReplies.push(createdEdge(O, Q, 'supports', 'existing'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog()).findByText(CONNECT_COPY.existing)).toBeTruthy();
    expect(note.value).toBe('My draft');
  });

  it('says what went wrong for a stale study, a node gone elsewhere (clearing it) and the question-target rule', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'answers' } });
    fireEvent.change(field('To'), { target: { value: O } });
    api.edgeReplies.push(
      jsonResponse(422, envelope('EDGE_TARGET_NOT_QUESTION')),
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 6 })),
      jsonResponse(404, envelope('NOT_FOUND')),
    );
    const connect = within(dialog()).getByRole('button', { name: 'Connect' });
    fireEvent.click(connect);
    await waitFor(() => expect(field('Relationship').getAttribute('aria-invalid')).toBe('true'));
    expect(within(dialog()).getByText(EDGE_RULE_COPY.targetNotQuestion)).toBeTruthy();

    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.click(connect);
    expect(await within(dialog()).findByText(CONNECT_COPY.conflict)).toBeTruthy();

    // The observation was deleted elsewhere: the refetched snapshot no longer has it.
    api.graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.filter((n) => n.id !== O),
      edges: [],
      positions: GRAPH.positions.filter((p) => p.nodeId !== O),
    };
    fireEvent.click(connect);
    expect(await within(dialog()).findByText(CONNECT_COPY.gone)).toBeTruthy();
    await waitFor(() => expect(field('To').value).toBe(''));
    const [first, second, third] = api.mutations();
    expect(second?.key).not.toBe(first?.key);
    expect(third?.key).not.toBe(second?.key);
  });

  it('shows the relationship limit as an alert in the dialog', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    api.edgeReplies.push(jsonResponse(422, envelope('EDGE_LIMIT_EXCEEDED')));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    expect(textOf(await within(dialog()).findByRole('alert'))).toBe(CONNECT_COPY.limit);
  });

  it('closes on a lifecycle refusal, locks the graph and moves focus to the locked alert', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    api.edgeReplies.push(jsonResponse(422, envelope('STUDY_TRASHED')));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const alert = screen.getByRole('alert');
    expect(textOf(alert)).toContain(GRAPH_COPY.locked);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
  });

  it('resends an unknown outcome verbatim with the same key on Retry', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    api.edgeReplies.push(new TypeError('offline'), createdEdge(S, O, 'supports'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog()).findByText(CONNECT_COPY.unknownAdd)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [first, retry] = api.mutations();
    expect(retry).toStrictEqual(first);
  });

  it('Cancel and Escape close it, send nothing and return focus; Escape waits while Connect is pending', async () => {
    await openList();
    const opener = rowConnect(S);
    fireEvent.click(opener);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.keyDown(field('Relationship'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // The selection around it is untouched by the dialog's Escape.
    expect(api.mutations()).toStrictEqual([]);

    fireEvent.click(opener);
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    let answer!: (response: Response) => void;
    api.edgeReplies.push(new Promise<Response>((resolve) => (answer = resolve)));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(within(dialog()).getByRole('button', { name: 'Connecting…' })).toBeTruthy(),
    );
    fireEvent.keyDown(field('Relationship'), { key: 'Escape' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeTruthy();
    // A second press while pending sends nothing more.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connecting…' }));
    act(() => answer(createdEdge(S, O, 'supports')));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(api.mutations()).toHaveLength(1);
  });

  it('prefills From and To from the toolbar in selection order, and needs one or two selected nodes', async () => {
    await openList();
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect…' });
    expect(connect.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name(O)}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name(Q)}` }));
    fireEvent.click(connect);
    expect(field('From').value).toBe(O);
    expect(field('To').value).toBe(Q);
    expect(document.activeElement).toBe(field('Relationship'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(connect);

    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name(O)}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name(O)}` }));
    fireEvent.click(connect);
    expect(field('From').value).toBe(Q);
    expect(field('To').value).toBe(O);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name(S)}` }));
    expect(connect.disabled).toBe(true);
    expect(textOf(document.getElementById(connect.getAttribute('aria-describedby') ?? ''))).toBe(
      GRAPH_COPY.selectToConnect,
    );
  });

  it('has no axe violations while open', async () => {
    await openList();
    fireEvent.click(rowConnect(S));
    fireEvent.change(field('Relationship'), { target: { value: 'supports' } });
    fireEvent.change(field('To'), { target: { value: O } });
    await expectNoA11yViolations(dialog());
  });
});
