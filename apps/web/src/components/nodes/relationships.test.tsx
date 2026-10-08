import type { Edge, NodeSummary } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_COPY } from '@/components/graph/connect-dialog';
import { studyQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { EDGE_RULE_COPY } from './relationship-controls';
import { RELATIONSHIPS_COPY, Relationships } from './relationships';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const OBS = '10000000-2222-4333-8444-555555555555';
const CON = '20000000-2222-4333-8444-555555555555';
const SCR = '30000000-2222-4333-8444-555555555555';
const THO = '40000000-2222-4333-8444-555555555555';
const T = '2026-10-02T12:00:00.000Z';

const node = (id: string, type: NodeSummary['type'], label: string): NodeSummary => ({
  id,
  type,
  origin: 'user',
  label,
  status: null,
  observationKind: null,
  referenceId: null,
  canonicalNodeId: null,
  established: false,
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
});
const NODES = [
  node(OBS, 'observation', 'Paul appeals to conscience'),
  node(CON, 'conclusion', 'Conscience testifies'),
  node(SCR, 'scripture', 'Romans 8:16'),
  node(THO, 'thought', 'A second witness'),
];

const edge = (
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: Edge['type'],
  note: string | null = null,
  revision = 1,
): Edge => ({
  id,
  sourceNodeId,
  targetNodeId,
  type,
  origin: 'user',
  note,
  revision,
  createdAt: T,
  updatedAt: T,
});
const E1 = 'e1000000-2222-4333-8444-555555555555';
const E2 = 'e2000000-2222-4333-8444-555555555555';
const E3 = 'e3000000-2222-4333-8444-555555555555';

const mutationBody = (e: Edge, extra: Record<string, unknown> = {}) => ({
  id: e.id,
  studyId: STUDY_ID,
  sourceNodeId: e.sourceNodeId,
  targetNodeId: e.targetNodeId,
  type: e.type,
  origin: 'user',
  revision: e.revision,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '9',
  establishmentClearedNodeIds: [],
  ...extra,
});
const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});

type Reply = Response | Error;
/** What `GET /edges?nodeId=` answers per node: the server's current state in a test. */
let server: Record<string, Edge[]>;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown; key: string | undefined }[];

function reply(route: string, ...answers: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);
}

beforeEach(() => {
  server = {};
  replies = new Map();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        key: headers['Idempotency-Key'],
      });
      const next = replies.get(`${method} ${path}`)?.shift();
      if (next) return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      const nodeId = url.searchParams.get('nodeId');
      if (method === 'GET' && url.pathname.endsWith('/edges') && nodeId) {
        return Promise.resolve(jsonResponse(200, { items: server[nodeId] ?? [] }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EDGES = `/studies/${STUDY_ID}/edges`;
const mutations = () => requests.filter((r) => r.method !== 'GET');

function renderFor(nodeId: string, { editable = true } = {}) {
  const props = {
    onLocked: vi.fn(),
    onShowNode: vi.fn(),
  };
  const self = NODES.find((n) => n.id === nodeId);
  if (!self) throw new Error('unknown node');
  const rendered = renderWithQuery(
    <Relationships
      studyId={STUDY_ID}
      node={{ id: nodeId, type: self.type }}
      nodes={NODES}
      studyRevision={4}
      editable={editable}
      {...props}
    />,
  );
  return { ...rendered, ...props };
}

const region = () => screen.getByRole('region', { name: 'Relationships' });
const sentences = () =>
  within(region())
    .queryAllByRole('listitem')
    .map((item) => textOf(item.querySelector('p')));
const status = () => textOf(screen.getAllByRole('status').find((el) => el.className === 'sr-only'));

describe('Relationships', () => {
  it('reads each relationship as a sentence with the direction in words, from either node', async () => {
    server[OBS] = [
      edge(E1, OBS, CON, 'supports', 'Both speak\nof witness'),
      edge(E2, SCR, OBS, 'supports'),
      edge(E3, OBS, THO, 'related_to'),
    ];
    server[CON] = [edge(E1, OBS, CON, 'supports', 'Both speak\nof witness')];
    server[THO] = [edge(E3, OBS, THO, 'related_to')];
    const first = renderFor(OBS);
    await waitFor(() => expect(sentences()).toHaveLength(3));
    expect(sentences()).toStrictEqual([
      'This observation supports Conclusion: Conscience testifies',
      'Scripture: Romans 8:16 supports this observation',
      'This observation is related to Thought: A second witness',
    ]);
    const firstItem = within(region()).getAllByRole('listitem')[0];
    expect(textOf(firstItem)).toContain('Supports · Added by You');
    expect(textOf(firstItem)).toContain('Note: Both speak of witness');
    fireEvent.click(within(firstItem!).getByRole('button', { name: /^Show/ }));
    expect(first.onShowNode).toHaveBeenCalledWith(CON);
    first.unmount();

    renderFor(CON);
    await waitFor(() => expect(sentences()).toHaveLength(1));
    expect(sentences()).toStrictEqual([
      'Observation: Paul appeals to conscience supports this conclusion',
    ]);
  });

  it('shows the empty state, and no Connect, Edit or Remove on a read-only study', async () => {
    renderFor(CON, { editable: true });
    expect(await screen.findByText(RELATIONSHIPS_COPY.empty)).toBeTruthy();
    server[OBS] = [edge(E1, OBS, CON, 'supports')];
    renderFor(OBS, { editable: false });
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    const readOnly = screen.getAllByRole('region', { name: 'Relationships' })[1]!;
    expect(within(readOnly).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(within(readOnly).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(readOnly).queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('connects by keyboard through the Connect dialog: From is this node, picks the type and To, swaps direction with a spoken preview, and says "Relationship added"', async () => {
    renderFor(OBS);
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    const connect = screen.getByRole('button', { name: 'Connect' });
    fireEvent.click(connect);
    const dialog = screen.getByRole('dialog', { name: CONNECT_COPY.title });
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'From' }).value).toBe(
      OBS,
    );
    const type = within(dialog).getByRole('combobox', { name: 'Relationship' });
    expect(document.activeElement).toBe(type);
    expect(dialog.querySelector('optgroup[label="More relationships"]')).not.toBeNull();

    fireEvent.change(type, { target: { value: 'supports' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'To' }), {
      target: { value: CON },
    });
    const preview = within(dialog).getByText(/ supports /);
    expect(preview.getAttribute('aria-live')).toBe('polite');
    expect(textOf(preview)).toBe(
      'Observation: Paul appeals to conscience supports Conclusion: Conscience testifies',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Swap direction' }));
    expect(textOf(preview)).toBe(
      'Conclusion: Conscience testifies supports Observation: Paul appeals to conscience',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Swap direction' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), {
      target: { value: 'Both speak of witness' },
    });

    const created = edge(E1, OBS, CON, 'supports', 'Both speak of witness');
    reply(
      `POST ${EDGES}`,
      jsonResponse(201, mutationBody(created, { outcome: 'created', studyRevision: 5 })),
    );
    server[OBS] = [created];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(status()).toBe(CONNECT_COPY.added));
    expect(mutations()).toStrictEqual([
      {
        method: 'POST',
        path: EDGES,
        body: {
          expectedRevision: 4,
          sourceNodeId: OBS,
          targetNodeId: CON,
          type: 'supports',
          note: 'Both speak of witness',
        },
        key: expect.any(String) as string,
      },
    ]);
    await waitFor(() => expect(sentences()).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect' }));
  });

  it('hides Swap direction for a two-way type, and Escape closes the dialog back to Connect', async () => {
    renderFor(OBS);
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog', { name: CONNECT_COPY.title });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Relationship' }), {
      target: { value: 'related_to' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'To' }), {
      target: { value: CON },
    });
    expect(within(dialog).queryByRole('button', { name: 'Swap direction' })).toBeNull();
    expect(within(dialog).getByText('No claim that one supports the other.')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Observation: Paul appeals to conscience is related to Conclusion: Conscience testifies',
      ),
    ).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'To' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect' }));
    expect(mutations()).toStrictEqual([]);
  });

  it('disables Connect with the reason when the study has no other node', async () => {
    renderWithQuery(
      <Relationships
        studyId={STUDY_ID}
        node={{ id: OBS, type: 'observation' }}
        nodes={NODES.filter((n) => n.id === OBS)}
        studyRevision={4}
        editable
        onLocked={vi.fn()}
        onShowNode={vi.fn()}
      />,
    );
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' });
    expect(connect.disabled).toBe(true);
    expect(textOf(document.getElementById(connect.getAttribute('aria-describedby') ?? ''))).toBe(
      CONNECT_COPY.noOther,
    );
  });

  it('keeps the dialog and draft when the relationship already exists, and says the note was not added', async () => {
    const existing = edge(E1, OBS, CON, 'references');
    renderFor(OBS);
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog', { name: CONNECT_COPY.title });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Relationship' }), {
      target: { value: 'references' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'To' }), {
      target: { value: CON },
    });
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(note, { target: { value: 'My draft' } });
    reply(
      `POST ${EDGES}`,
      jsonResponse(
        200,
        mutationBody(existing, { outcome: 'existing', studyRevision: 4, lastEventSequence: null }),
      ),
    );
    // Made in another tab: this node's list hasn't seen it yet, and refetches on 'existing'.
    server[OBS] = [existing];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText(CONNECT_COPY.existing)).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe('My draft');
    expect(screen.getByRole('dialog', { name: CONNECT_COPY.title })).toBe(dialog);
    await waitFor(() =>
      expect(sentences()).toStrictEqual([
        'This observation references Conclusion: Conscience testifies',
      ]),
    );
  });

  it('resends the same key and body on Retry after an unknown outcome, and asks to press Connect again after a 409', async () => {
    const { queryClient } = renderFor(OBS);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog', { name: CONNECT_COPY.title });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Relationship' }), {
      target: { value: 'supports' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'To' }), {
      target: { value: CON },
    });
    reply(
      `POST ${EDGES}`,
      new TypeError('offline'),
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 6 })),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText(CONNECT_COPY.unknownAdd)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText(CONNECT_COPY.conflict)).toBeTruthy();
    const [first, retry] = mutations();
    expect(retry).toStrictEqual(first);
    // The study is re-read, so the next Connect goes out on its current revision.
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(
      studyQueryKey(STUDY_ID),
    );
  });

  it('treats the browser closing the dialog while idle as Cancel: focus returns to Connect, which opens it again', async () => {
    renderFor(OBS);
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    const connect = screen.getByRole('button', { name: 'Connect' });
    fireEvent.click(connect);
    const dialog = screen.getByRole<HTMLDialogElement>('dialog', { name: CONNECT_COPY.title });
    act(() => dialog.close());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(connect);
    fireEvent.click(connect);
    expect(screen.getByRole<HTMLDialogElement>('dialog', { name: CONNECT_COPY.title }).open).toBe(
      true,
    );
    expect(mutations()).toStrictEqual([]);
  });

  it('closes the dialog and turns read-only through onLocked on a lifecycle refusal, and shows the target rule next to Relationship', async () => {
    const { onLocked } = renderFor(OBS);
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog', { name: CONNECT_COPY.title });
    const type = within(dialog).getByRole('combobox', { name: 'Relationship' });
    fireEvent.change(type, { target: { value: 'answers' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'To' }), {
      target: { value: CON },
    });
    reply(
      `POST ${EDGES}`,
      jsonResponse(422, envelope('EDGE_TARGET_NOT_QUESTION')),
      jsonResponse(422, envelope('STUDY_ARCHIVED')),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(type.getAttribute('aria-invalid')).toBe('true'));
    expect(within(dialog).getByText(EDGE_RULE_COPY.targetNotQuestion)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onLocked).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edits within the same direction class with a preview, saves only after the 200, and keeps the draft on a 409 until Reload', async () => {
    server[OBS] = [edge(E1, OBS, CON, 'supports', 'Old note')];
    renderFor(OBS);
    await waitFor(() => expect(sentences()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    const form = screen.getByRole('form', { name: 'Edit relationship' });
    const type = within(form).getByRole('combobox', { name: 'Relationship' });
    expect(document.activeElement).toBe(type);
    const offered = within(type)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(offered).toHaveLength(13);
    expect(offered).not.toContain('Related to');
    expect(offered).not.toContain('Parallels');
    fireEvent.change(type, { target: { value: 'qualifies' } });
    expect(
      within(form).getByText('This observation qualifies Conclusion: Conscience testifies'),
    ).toBeTruthy();
    const note = within(form).getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(note, { target: { value: 'New note' } });

    reply(
      `PATCH ${EDGES}/${E1}`,
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })),
    );
    fireEvent.submit(form);
    expect(await within(form).findByText(RELATIONSHIPS_COPY.editConflict)).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe('New note');
    server[OBS] = [edge(E1, OBS, CON, 'explains', 'Elsewhere', 2)];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((note as HTMLTextAreaElement).value).toBe('Elsewhere'));

    const saved = edge(E1, OBS, CON, 'qualifies', 'Elsewhere', 3);
    reply(`PATCH ${EDGES}/${E1}`, jsonResponse(200, mutationBody(saved)));
    server[OBS] = [saved];
    fireEvent.change(type, { target: { value: 'qualifies' } });
    fireEvent.submit(form);
    await waitFor(() => expect(status()).toBe(RELATIONSHIPS_COPY.saved));
    expect(mutations().map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, type: 'qualifies', note: 'New note' },
      { expectedRevision: 2, type: 'qualifies', note: 'Elsewhere' },
    ]);
    expect(screen.queryByRole('form', { name: 'Edit relationship' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Edit/ }));
  });

  it('says a conclusion it supported lost "Established by me" after a remove or a type change cleared it (BIB-30)', async () => {
    server[OBS] = [edge(E1, OBS, CON, 'supports')];
    renderFor(OBS);
    await waitFor(() => expect(sentences()).toHaveLength(1));
    const [item] = screen.getAllByRole('listitem');
    fireEvent.click(within(item!).getByRole('button', { name: /^Remove/ }));
    reply(
      `DELETE ${EDGES}/${E1}`,
      jsonResponse(
        200,
        mutationBody(edge(E1, OBS, CON, 'supports', null, 2), {
          establishmentClearedNodeIds: [CON],
        }),
      ),
    );
    server[OBS] = [];
    fireEvent.click(
      within(within(item!).getByRole('group', { name: 'Remove relationship' })).getByRole(
        'button',
        {
          name: 'Remove',
        },
      ),
    );
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    expect(status()).toBe(`${RELATIONSHIPS_COPY.removed} ${RELATIONSHIPS_COPY.markerCleared}`);
  });

  it('removes after an inline confirm, says so, and moves focus to the next relationship (or Connect)', async () => {
    server[OBS] = [edge(E1, OBS, CON, 'supports'), edge(E2, SCR, OBS, 'supports')];
    renderFor(OBS);
    await waitFor(() => expect(sentences()).toHaveLength(2));
    const [firstItem] = screen.getAllByRole('listitem');
    fireEvent.click(within(firstItem!).getByRole('button', { name: /^Remove/ }));
    const confirm = within(firstItem!).getByRole('group', { name: 'Remove relationship' });
    expect(textOf(confirm)).toContain(RELATIONSHIPS_COPY.removeConfirm);
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Remove' }));

    reply(
      `DELETE ${EDGES}/${E1}`,
      jsonResponse(200, mutationBody(edge(E1, OBS, CON, 'supports', null, 2))),
    );
    server[OBS] = [edge(E2, SCR, OBS, 'supports')];
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sentences()).toHaveLength(1));
    expect(status()).toBe(RELATIONSHIPS_COPY.removed);
    expect(mutations()).toStrictEqual([
      {
        method: 'DELETE',
        path: `${EDGES}/${E1}`,
        body: { expectedRevision: 1 },
        key: expect.any(String) as string,
      },
    ]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('listitem')));

    const [last] = screen.getAllByRole('listitem');
    fireEvent.click(within(last!).getByRole('button', { name: /^Remove/ }));
    reply(
      `DELETE ${EDGES}/${E2}`,
      jsonResponse(200, mutationBody(edge(E2, SCR, OBS, 'supports', null, 2))),
    );
    server[OBS] = [];
    fireEvent.click(within(last!).getByRole('button', { name: 'Remove' }));
    await screen.findByText(RELATIONSHIPS_COPY.empty);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect' })),
    );
  });
});
