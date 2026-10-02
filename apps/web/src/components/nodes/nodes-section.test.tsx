import type { StudyResponse } from '@bible-artisan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_ADD_COPY } from '@/lib/add-node';
import { libraryQueryKey, studyQueryKey } from '@/lib/studies';
import { EDITION_ID, TRANSLATION } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { ADD_NODE_COPY } from './add-node-form';
import { NODE_DETAIL_COPY } from './node-detail';
import { NODES_COPY, NodesSection } from './nodes-section';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NODE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const SCRIPTURE_ID = 'cccccccc-2222-4333-8444-555555555555';
const REFERENCE_ID = 'dddddddd-2222-4333-8444-555555555555';
const DUPLICATE_ID = 'ffffffff-2222-4333-8444-555555555555';
const T = '2026-10-01T12:00:00.000Z';
const STUDY: StudyResponse = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 4,
  contentRevision: 3,
  startingReference: null,
  mainQuestion: null,
  originalQuestion: null,
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: T,
};
const ROMANS = {
  id: REFERENCE_ID,
  editionId: EDITION_ID,
  bookCode: 'ROM',
  startChapter: 9,
  startVerse: 1,
  endChapter: 9,
  endVerse: 1,
  label: 'Romans 9:1',
};

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: NODE_ID,
  type: 'thought',
  origin: 'user',
  label: 'Maybe a second witness',
  status: null,
  observationKind: null,
  referenceId: null,
  canonicalNodeId: null,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});
const common = (overrides: Record<string, unknown> = {}) => ({
  id: NODE_ID,
  studyId: STUDY_ID,
  origin: 'user',
  canonicalNodeId: null,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});
const mutation = (overrides: Record<string, unknown> = {}) => ({
  id: NODE_ID,
  studyId: STUDY_ID,
  type: 'thought',
  origin: 'user',
  revision: 1,
  referenceId: null,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '6',
  outcome: 'created',
  canonicalNodeId: null,
  ...overrides,
});
const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});

type Reply = Response | Error | Promise<Response>;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown; key: string | undefined }[];

/** Queues the next answers for `METHOD path` (path relative to /v1). */
function reply(route: string, ...answers: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);
}

beforeEach(() => {
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
      if (method === 'GET' && path === '/bible/translations') {
        return Promise.resolve(jsonResponse(200, { translations: [TRANSLATION] }));
      }
      const next = replies.get(`${method} ${path}`)?.shift();
      if (!next) throw new Error(`unexpected ${method} ${path}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NODES = `/studies/${STUDY_ID}/nodes`;
const NODE = `${NODES}/${NODE_ID}`;
const posts = () => requests.filter((r) => r.method === 'POST' && r.path === NODES);

function renderSection(study: StudyResponse = STUDY) {
  const onReload = vi.fn(() => Promise.resolve());
  const rendered = renderWithQuery(<NodesSection study={study} onReload={onReload} />);
  rendered.queryClient.setQueryData(studyQueryKey(STUDY_ID), study);
  return { ...rendered, onReload };
}

/** Opens Add node; the Type radio group has focus. */
async function openAdd() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add node' }));
  const group = screen.getByRole('group', { name: 'Type' });
  expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Thought' }));
  return group;
}

describe('NodesSection', () => {
  it('lists each node with its type, origin and status or kind as text, and the count', async () => {
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [
          summary({
            id: SCRIPTURE_ID,
            type: 'scripture',
            origin: 'scripture',
            label: 'Romans 9:1',
            referenceId: REFERENCE_ID,
          }),
          summary({
            id: 'eeeeeeee-2222-4333-8444-555555555551',
            type: 'question',
            label: 'Q?',
            status: 'open',
          }),
          summary({
            id: 'eeeeeeee-2222-4333-8444-555555555552',
            type: 'observation',
            label: 'Paul appeals',
            observationKind: 'interpretation',
          }),
          summary({
            id: 'eeeeeeee-2222-4333-8444-555555555553',
            type: 'conclusion',
            label: 'It bears witness',
            status: 'tentative',
          }),
          summary({
            id: 'eeeeeeee-2222-4333-8444-555555555554',
            type: 'source',
            origin: 'external',
            label: 'Commentary',
          }),
          summary(),
        ],
      }),
    );
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Nodes (6)' })).toBeTruthy();
    expect(
      within(screen.getByRole('list'))
        .getAllByRole('button')
        .map((button) => [textOf(button), button.getAttribute('aria-pressed')]),
    ).toStrictEqual([
      ['Scripture · Scripture Text Romans 9:1', 'false'],
      ['Question · You · Open Q?', 'false'],
      ['Observation · You · Interpretation Paul appeals', 'false'],
      ['Conclusion · You · Tentative It bears witness', 'false'],
      ['Source · External Source Commentary', 'false'],
      ['Thought · You Maybe a second witness', 'false'],
    ]);
  });

  it('says when it is loading, when there are no nodes, and offers Retry when loading fails', async () => {
    let answer: (response: Response) => void = () => undefined;
    reply(`GET ${NODES}`, new Promise<Response>((resolve) => (answer = resolve)));
    renderSection();
    expect(screen.getByText(NODES_COPY.loading)).toBeTruthy();
    answer(jsonResponse(200, { items: [] }));
    expect(await screen.findByText(NODES_COPY.empty)).toBeTruthy();

    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) =>
        input.endsWith('/nodes')
          ? Promise.reject(new TypeError('offline'))
          : Promise.reject(new Error('unexpected')),
      ),
    );
    const other = renderWithQuery(
      <NodesSection study={{ ...STUDY, id: NODE_ID }} onReload={() => Promise.resolve()} />,
    );
    expect(textOf(await within(other.container).findByRole('alert'))).toContain(
      "Couldn't load the nodes.",
    );
    expect(within(other.container).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('adds a thought by keyboard: type, text, Create; then selects it, focuses its detail and announces it', async () => {
    reply(
      `GET ${NODES}`,
      jsonResponse(200, { items: [] }),
      jsonResponse(200, { items: [summary()] }),
    );
    reply(`POST ${NODES}`, jsonResponse(201, { ...mutation(), studyRevision: 5 }));
    reply(
      `GET ${NODE}`,
      jsonResponse(200, { type: 'thought', ...common(), text: 'Maybe a\nsecond witness' }),
    );
    const { queryClient } = renderSection();
    await openAdd();
    fireEvent.change(screen.getByLabelText('Text'), {
      target: { value: '  Maybe a\nsecond witness ' },
    });
    expect(screen.getByText('22 / 10,000 characters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const heading = await screen.findByRole('heading', { level: 3, name: 'Thought' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(posts()).toStrictEqual([
      {
        method: 'POST',
        path: NODES,
        body: { type: 'thought', expectedRevision: 4, text: '  Maybe a\nsecond witness ' },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(
      screen
        .getByRole('button', { name: 'Thought · You Maybe a second witness' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('Thought added')).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Thought' });
    expect(textOf(region)).toContain('TextMaybe a second witness');
    expect(within(region).getByText('You')).toBeTruthy();
    // The study moved to the creation's revision.
    expect(queryClient.getQueryData<StudyResponse>(studyQueryKey(STUDY_ID))?.revision).toBe(5);
  });

  it.each([
    [
      'Question',
      (set: (label: string | RegExp, value: string) => void) =>
        set('Statement', 'What is conscience?'),
      { type: 'question', expectedRevision: 4, text: 'What is conscience?' },
    ],
    [
      'Conclusion',
      (set: (label: string | RegExp, value: string) => void) =>
        set('Statement', 'It bears witness.'),
      { type: 'conclusion', expectedRevision: 4, text: 'It bears witness.' },
    ],
    [
      'Observation',
      (set: (label: string | RegExp, value: string) => void) => {
        fireEvent.click(screen.getByRole('radio', { name: 'Interpretation' }));
        set('Text', 'Paul appeals.');
      },
      {
        type: 'observation',
        expectedRevision: 4,
        text: 'Paul appeals.',
        observationKind: 'interpretation',
      },
    ],
    [
      'Source',
      (set: (label: string | RegExp, value: string) => void) => {
        set(/^Title/, 'Commentary on Romans');
        fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: 'commentary' } });
        set('URL', 'https://example.org/romans');
        set('Excerpt', 'Quoted words');
        fireEvent.click(screen.getByRole('radio', { name: 'Quotation' }));
      },
      {
        type: 'source',
        expectedRevision: 4,
        source: {
          title: 'Commentary on Romans',
          kind: 'commentary',
          author: '',
          workTitle: '',
          publicationDetails: '',
          url: 'https://example.org/romans',
          locator: '',
          excerpt: 'Quoted words',
          excerptKind: 'quotation',
        },
      },
    ],
  ])('creates a %s from its own fields', async (type, fill, body) => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(`POST ${NODES}`, new TypeError('stop here'));
    renderSection();
    const group = await openAdd();
    fireEvent.click(within(group).getByRole('radio', { name: type }));
    fill((label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(NODE_ADD_COPY.unknown);
    expect(posts().map((r) => r.body)).toStrictEqual([body]);
  });

  it('checks the draft before sending: a source needs a URL or a locator, and a non-http URL is refused', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }));
    renderSection();
    const group = await openAdd();
    fireEvent.click(within(group).getByRole('radio', { name: 'Source' }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'A book' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Add a URL or a locator.', { selector: '.text-accent' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Enter a link that starts with http:// or https://.')).toBeTruthy();
    expect(screen.getByLabelText('URL').getAttribute('aria-invalid')).toBe('true');
    expect(posts()).toStrictEqual([]);
  });

  it('creates a Scripture node only from a resolved passage, offering candidates for an ambiguous book', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(
      'POST /bible/resolve',
      jsonResponse(200, { outcome: 'not_reference' }),
      jsonResponse(200, {
        outcome: 'ambiguous',
        candidates: [{ bookCode: 'ROM', bookName: 'Romans', input: 'Romans 9:1' }],
      }),
      jsonResponse(200, { outcome: 'resolved', reference: ROMANS }),
    );
    reply(`POST ${NODES}`, new TypeError('stop here'));
    renderSection();
    const group = await openAdd();
    fireEvent.click(within(group).getByRole('radio', { name: 'Scripture' }));
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByLabelText('Passage'), { target: { value: 'conscience' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText(ADD_NODE_COPY.notReference)).toBeTruthy();
    fireEvent.click(create);
    expect(posts()).toStrictEqual([]);

    fireEvent.change(screen.getByLabelText('Passage'), { target: { value: 'Ro 9:1' } });
    fireEvent.keyDown(screen.getByLabelText('Passage'), { key: 'Enter' });
    const candidates = await screen.findByRole('group', { name: 'Which book did you mean?' });
    fireEvent.click(within(candidates).getByRole('button', { name: 'Romans' }));
    expect(await screen.findByText('Resolved: Romans 9:1 (World English Bible)')).toBeTruthy();
    expect(requests.filter((r) => r.path === '/bible/resolve').map((r) => r.body)).toStrictEqual([
      { input: 'conscience', editionId: EDITION_ID },
      { input: 'Ro 9:1', editionId: EDITION_ID },
      { input: 'Romans 9:1', editionId: EDITION_ID },
    ]);
    expect(create.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(create);
    await screen.findByText(NODE_ADD_COPY.unknown);
    expect(posts().map((r) => r.body)).toStrictEqual([
      { type: 'scripture', expectedRevision: 4, referenceId: REFERENCE_ID },
    ]);
  });

  it('focuses a passage already in the study, then adds a separate copy labeled Duplicate whose original is one button away', async () => {
    const existing = summary({
      id: SCRIPTURE_ID,
      type: 'scripture',
      origin: 'scripture',
      label: 'Romans 9:1',
      referenceId: REFERENCE_ID,
    });
    const copy = summary({
      id: DUPLICATE_ID,
      type: 'scripture',
      origin: 'scripture',
      label: 'Romans 9:1',
      referenceId: REFERENCE_ID,
      canonicalNodeId: SCRIPTURE_ID,
    });
    const scriptureDetail = (id: string, canonicalNodeId: string | null) =>
      jsonResponse(200, {
        type: 'scripture',
        ...common({ id, origin: 'scripture', canonicalNodeId }),
        reference: ROMANS,
      });
    const scriptureMutation = (overrides: Record<string, unknown>) =>
      mutation({ type: 'scripture', origin: 'scripture', referenceId: REFERENCE_ID, ...overrides });
    reply(
      `GET ${NODES}`,
      jsonResponse(200, { items: [existing] }),
      jsonResponse(200, { items: [existing] }),
      jsonResponse(200, { items: [existing, copy] }),
      jsonResponse(200, { items: [existing, copy] }),
    );
    reply('POST /bible/resolve', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    reply(
      `POST ${NODES}`,
      jsonResponse(
        200,
        scriptureMutation({ id: SCRIPTURE_ID, outcome: 'focused_existing', studyRevision: 5 }),
      ),
      jsonResponse(
        201,
        scriptureMutation({
          id: DUPLICATE_ID,
          outcome: 'explicit_duplicate',
          canonicalNodeId: SCRIPTURE_ID,
          studyRevision: 6,
        }),
      ),
    );
    reply(`GET ${NODES}/${SCRIPTURE_ID}`, scriptureDetail(SCRIPTURE_ID, null));
    reply(`GET ${NODES}/${DUPLICATE_ID}`, scriptureDetail(DUPLICATE_ID, SCRIPTURE_ID));
    const { queryClient } = renderSection();
    const group = await openAdd();
    fireEvent.click(within(group).getByRole('radio', { name: 'Scripture' }));
    fireEvent.change(screen.getByLabelText('Passage'), { target: { value: 'Rom 9:1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await screen.findByText(/^Resolved: Romans 9:1/);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // focused_existing: the existing node opens with focus on its heading; the form closes.
    const original = await screen.findByRole('region', { name: 'Scripture' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(original).getByRole('heading', { name: 'Scripture' }),
      ),
    );
    expect(screen.queryByRole('heading', { name: 'Add a node' })).toBeNull();
    // Shown next to "Add a separate copy" and announced in the section's polite live region.
    const said = screen.getAllByText(NODE_ADD_COPY.focused('Romans 9:1'));
    expect(said.map((el) => el.getAttribute('role'))).toStrictEqual(['status', null]);
    expect(within(original).queryByText('Duplicate')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show it' })).toBeNull();
    expect(queryClient.getQueryData<StudyResponse>(studyQueryKey(STUDY_ID))?.revision).toBe(5);

    fireEvent.click(screen.getByRole('button', { name: 'Add a separate copy' }));
    // The detail now shows the new duplicate (a new region replaces the original's).
    await screen.findByRole('button', { name: 'Show the original' });
    const duplicate = screen.getByRole('region', { name: 'Scripture' });
    const [first, second] = posts();
    expect([first?.body, second?.body]).toStrictEqual([
      { type: 'scripture', expectedRevision: 4, referenceId: REFERENCE_ID },
      {
        type: 'scripture',
        // The revision the focus moved the study to.
        expectedRevision: 5,
        referenceId: REFERENCE_ID,
        duplicatePolicy: 'explicit_duplicate',
      },
    ]);
    // A different request, so a new Idempotency-Key.
    expect(second?.key).not.toBe(first?.key);
    expect(screen.getByText(NODE_ADD_COPY.duplicate('Romans 9:1'))).toBeTruthy();
    expect(screen.queryByText(/already in this study/)).toBeNull();
    // "Duplicate" is text in the list and the detail, never color alone.
    expect(
      await screen.findByRole('button', {
        name: 'Scripture · Scripture Text · Duplicate Romans 9:1',
      }),
    ).toBeTruthy();
    expect(textOf(within(duplicate).getByText(/^of /).closest('p'))).toBe(
      'Duplicate of Romans 9:1',
    );

    fireEvent.click(within(duplicate).getByRole('button', { name: 'Show the original' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Scripture · Scripture Text Romans 9:1' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    const shown = screen.getByRole('region', { name: 'Scripture' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(shown).getByRole('heading', { name: 'Scripture' }),
      ),
    );
    expect(within(shown).queryByRole('button', { name: 'Show the original' })).toBeNull();
  });

  it('opens the node named by ?node= once the list has it, and ignores an id it does not list', async () => {
    const existing = summary({
      id: SCRIPTURE_ID,
      type: 'scripture',
      origin: 'scripture',
      label: 'Romans 9:1',
      referenceId: REFERENCE_ID,
    });
    reply(`GET ${NODES}`, jsonResponse(200, { items: [existing] }));
    reply(
      `GET ${NODES}/${SCRIPTURE_ID}`,
      jsonResponse(200, {
        type: 'scripture',
        ...common({ id: SCRIPTURE_ID, origin: 'scripture' }),
        reference: ROMANS,
      }),
    );
    const onReload = vi.fn(() => Promise.resolve());
    const { unmount } = renderWithQuery(
      <NodesSection study={STUDY} onReload={onReload} initialNodeId={SCRIPTURE_ID} />,
    );
    const region = await screen.findByRole('region', { name: 'Scripture' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole('heading', { name: 'Scripture' }),
      ),
    );
    unmount();

    reply(`GET ${NODES}`, jsonResponse(200, { items: [existing] }));
    renderWithQuery(
      <NodesSection study={STUDY} onReload={onReload} initialNodeId="not-a-listed-node" />,
    );
    await screen.findByRole('button', { name: 'Scripture · Scripture Text Romans 9:1' });
    expect(screen.queryByRole('region', { name: 'Scripture' })).toBeNull();
    expect(requests.filter((r) => r.path.startsWith(`${NODES}/`))).toHaveLength(1);
  });

  it('keeps the draft on a 409 and asks to press Create again; Retry after an unknown outcome resends the same key and body', async () => {
    reply(
      `GET ${NODES}`,
      jsonResponse(200, { items: [] }),
      jsonResponse(200, { items: [summary()] }),
    );
    reply(
      `POST ${NODES}`,
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 5 })),
      new TypeError('offline'),
      jsonResponse(201, { ...mutation(), studyRevision: 6 }),
    );
    reply(`GET ${NODE}`, jsonResponse(200, { type: 'thought', ...common(), text: 'Kept' }));
    const { onReload } = renderSection();
    await openAdd();
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Kept' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(textOf(await screen.findByRole('alert'))).toBe(NODE_ADD_COPY.conflict('Create'));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toBe('Kept');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(textOf(await screen.findByRole('alert'))).toBe(`${NODE_ADD_COPY.unknown}Retry`);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('region', { name: 'Thought' });
    const [first, second, third] = posts();
    // The 409 was definite, so the next press is a new request; the retry resends it verbatim.
    expect(second?.key).not.toBe(first?.key);
    expect([third?.key, third?.body]).toStrictEqual([second?.key, second?.body]);
  });

  it('closes Add node with Escape or Cancel and returns focus to Add node', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }));
    renderSection();
    await openAdd();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Thought' }), { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add node' })),
    );
    await openAdd();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add node' })),
    );
  });

  it('shows a source citation, linking its URL only when it is http or https', async () => {
    const source = (url: string) => ({
      type: 'source',
      ...common({ origin: 'external' }),
      source: {
        title: 'Commentary',
        kind: 'commentary',
        author: 'J. Calvin',
        workTitle: null,
        publicationDetails: null,
        url,
        locator: 'ch. 9',
        excerpt: 'Witness of God',
        excerptKind: 'paraphrase',
      },
    });
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [summary({ type: 'source', origin: 'external', label: 'Commentary' })],
      }),
    );
    reply(`GET ${NODE}`, jsonResponse(200, source('https://example.org/calvin')));
    const view = renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Source · External Source Commentary' }),
    );
    const region = await screen.findByRole('region', { name: 'Source' });
    const link = within(region).getByRole('link', {
      name: 'https://example.org/calvin (opens in a new tab)',
    });
    expect([
      link.getAttribute('href'),
      link.getAttribute('target'),
      link.getAttribute('rel'),
    ]).toStrictEqual(['https://example.org/calvin', '_blank', 'noopener noreferrer nofollow']);
    expect(textOf(within(region).getByText('Paraphrase (External Source)').parentElement)).toBe(
      'Paraphrase (External Source)Witness of God',
    );

    view.unmount();
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [summary({ type: 'source', origin: 'external', label: 'Commentary' })],
      }),
    );
    reply(`GET ${NODE}`, jsonResponse(200, source('javascript:alert(1)')));
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Source · External Source Commentary' }),
    );
    const unsafe = await screen.findByRole('region', { name: 'Source' });
    expect(within(unsafe).getByText('javascript:alert(1)')).toBeTruthy();
    expect(within(unsafe).queryByRole('link')).toBeNull();
  });

  it('edits an observation: Saved only after the 200, then focus returns to Edit', async () => {
    const observation = {
      type: 'observation',
      ...common(),
      text: 'First look',
      observationKind: 'textual_observation',
    };
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [
          summary({
            type: 'observation',
            observationKind: 'textual_observation',
            label: 'First look',
          }),
        ],
      }),
      jsonResponse(200, {
        items: [
          summary({ type: 'observation', observationKind: 'interpretation', label: 'Second look' }),
        ],
      }),
    );
    reply(
      `GET ${NODE}`,
      jsonResponse(200, observation),
      jsonResponse(200, {
        ...observation,
        revision: 2,
        text: 'Second look',
        observationKind: 'interpretation',
      }),
    );
    let answer: (response: Response) => void = () => undefined;
    reply(`PATCH ${NODE}`, new Promise<Response>((resolve) => (answer = resolve)));
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /^Observation · You · Textual observation/ }),
    );
    const region = await screen.findByRole('region', { name: 'Observation' });
    fireEvent.click(within(region).getByRole('button', { name: 'Edit' }));
    const form = within(region).getByRole('form', { name: 'Edit observation' });
    expect(within(form).getByLabelText<HTMLTextAreaElement>('Text').value).toBe('First look');
    fireEvent.click(within(form).getByRole('radio', { name: 'Interpretation' }));
    fireEvent.change(within(form).getByLabelText('Text'), { target: { value: 'Second look' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        within(form).getByRole('button', { name: 'Saving…' }).getAttribute('aria-disabled'),
      ).toBe('true'),
    );
    expect(screen.queryByText('Saved')).toBeNull();
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, text: 'Second look', observationKind: 'interpretation' },
    ]);
    await act(async () => {
      answer(jsonResponse(200, mutation({ type: 'observation', revision: 2 })));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Edit' })),
    );
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(await within(region).findByText('Second look')).toBeTruthy();
  });

  it('edits a source to drop its excerpt: emptying the excerpt clears its kind, the edit saves and the library is marked stale', async () => {
    const citation = {
      title: 'Commentary',
      kind: 'commentary',
      author: null,
      workTitle: null,
      publicationDetails: null,
      url: null,
      locator: 'ch. 9',
      excerpt: 'Witness of God',
      excerptKind: 'paraphrase',
    };
    const source = { type: 'source', ...common({ origin: 'external' }), source: citation };
    const listed = jsonResponse(200, {
      items: [summary({ type: 'source', origin: 'external', label: 'Commentary' })],
    });
    reply(`GET ${NODES}`, listed, listed.clone());
    reply(
      `GET ${NODE}`,
      jsonResponse(200, source),
      jsonResponse(200, {
        ...source,
        revision: 2,
        source: { ...citation, excerpt: null, excerptKind: null },
      }),
    );
    reply(`PATCH ${NODE}`, jsonResponse(200, mutation({ type: 'source', revision: 2 })));
    const view = renderSection();
    const library = libraryQueryKey({ sort: 'recent' });
    view.queryClient.setQueryData(library, { items: [], nextCursor: null });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Source · External Source Commentary' }),
    );
    const region = await screen.findByRole('region', { name: 'Source' });
    fireEvent.click(within(region).getByRole('button', { name: 'Edit' }));
    const form = within(region).getByRole('form', { name: 'Edit source' });
    const radio = (name: string) => within(form).getByRole<HTMLInputElement>('radio', { name });
    expect([radio('No excerpt').checked, radio('Paraphrase').checked]).toStrictEqual([false, true]);
    fireEvent.change(within(form).getByLabelText('Excerpt'), { target: { value: '' } });
    expect([radio('No excerpt').checked, radio('Paraphrase').checked]).toStrictEqual([true, false]);
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toStrictEqual([
      {
        expectedRevision: 1,
        source: {
          title: 'Commentary',
          kind: 'commentary',
          author: '',
          workTitle: '',
          publicationDetails: '',
          url: '',
          locator: 'ch. 9',
          excerpt: '',
        },
      },
    ]);
    expect(view.queryClient.getQueryState(library)?.isInvalidated).toBe(true);
  });

  it('offers No excerpt as an explicit choice that unsets a kind picked by mistake', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(`POST ${NODES}`, new TypeError('stop here'));
    renderSection();
    const group = await openAdd();
    fireEvent.click(within(group).getByRole('radio', { name: 'Source' }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Commentary' } });
    fireEvent.change(screen.getByLabelText('Locator'), { target: { value: 'p. 1' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Quotation' }));
    fireEvent.click(screen.getByRole('radio', { name: 'No excerpt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(NODE_ADD_COPY.unknown);
    expect(posts().map((r) => (r.body as { source: object }).source)).toStrictEqual([
      {
        title: 'Commentary',
        kind: 'book',
        author: '',
        workTitle: '',
        publicationDetails: '',
        url: '',
        locator: 'p. 1',
        excerpt: '',
      },
    ]);
  });

  it('keeps the draft on a 409 and replaces it only after Reload is confirmed; says when nothing changed', async () => {
    const thought = { type: 'thought', ...common(), text: 'Mine' };
    reply(`GET ${NODES}`, jsonResponse(200, { items: [summary({ label: 'Mine' })] }));
    reply(
      `GET ${NODE}`,
      jsonResponse(200, thought),
      jsonResponse(200, { ...thought, revision: 2, text: 'Theirs' }),
    );
    reply(
      `PATCH ${NODE}`,
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })),
      jsonResponse(422, envelope('NODE_UNCHANGED')),
    );
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Thought · You Mine' }));
    const region = await screen.findByRole('region', { name: 'Thought' });
    fireEvent.click(within(region).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(region).getByLabelText('Text'), { target: { value: 'My edit' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(textOf(await within(region).findByRole('alert'))).toBe(
      `${NODE_DETAIL_COPY.conflict}Reload`,
    );
    expect(within(region).getByLabelText<HTMLTextAreaElement>('Text').value).toBe('My edit');

    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    fireEvent.click(within(region).getByRole('button', { name: 'Reload' }));
    expect(within(region).getByLabelText<HTMLTextAreaElement>('Text').value).toBe('My edit');
    fireEvent.click(within(region).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(region).getByLabelText<HTMLTextAreaElement>('Text').value).toBe('Theirs'),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(textOf(await within(region).findByRole('alert'))).toBe(NODE_DETAIL_COPY.unchanged);
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, text: 'My edit' },
      { expectedRevision: 2, text: 'Theirs' },
    ]);
  });

  it('is read-only for an archived study: nodes and details are readable, with no Add node or Edit', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NODE}`, jsonResponse(200, { type: 'thought', ...common(), text: 'T' }));
    renderSection({ ...STUDY, lifecycle: 'archived' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Thought · You Maybe a second witness' }),
    );
    const region = await screen.findByRole('region', { name: 'Thought' });
    expect(screen.getByText(NODES_COPY.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add node' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('turns read-only with Reload when a create is refused because the study was archived elsewhere', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [] }));
    reply(`POST ${NODES}`, jsonResponse(422, envelope('STUDY_ARCHIVED')));
    const { onReload } = renderSection();
    await openAdd();
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toBe(`${NODES_COPY.locked}Reload`);
    expect(screen.queryByRole('button', { name: 'Add node' })).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
  describe('adding a passage through the shared add request (BIB-26)', () => {
    const existing = summary({
      id: SCRIPTURE_ID,
      type: 'scripture',
      origin: 'scripture',
      label: 'Romans 9:1',
      referenceId: REFERENCE_ID,
    });
    const scriptureMutation = (overrides: Record<string, unknown>) =>
      mutation({ type: 'scripture', origin: 'scripture', referenceId: REFERENCE_ID, ...overrides });
    const COPY_BODY = {
      type: 'scripture',
      referenceId: REFERENCE_ID,
      expectedRevision: 5,
      duplicatePolicy: 'explicit_duplicate',
    };

    /** Adds Romans 9:1, which the study already holds: its node opens with "Add a separate copy". */
    async function focusExisting(items: unknown[] = [existing]) {
      reply(`GET ${NODES}`, ...Array.from({ length: 8 }, () => jsonResponse(200, { items })));
      reply(
        `GET ${NODES}/${SCRIPTURE_ID}`,
        ...Array.from({ length: 4 }, () =>
          jsonResponse(200, {
            type: 'scripture',
            ...common({ id: SCRIPTURE_ID, origin: 'scripture' }),
            reference: ROMANS,
          }),
        ),
      );
      reply('POST /bible/resolve', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
      reply(
        `POST ${NODES}`,
        jsonResponse(
          200,
          scriptureMutation({ id: SCRIPTURE_ID, outcome: 'focused_existing', studyRevision: 5 }),
        ),
      );
      const rendered = renderSection();
      const group = await openAdd();
      fireEvent.click(within(group).getByRole('radio', { name: 'Scripture' }));
      fireEvent.change(screen.getByLabelText('Passage'), { target: { value: 'Rom 9:1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
      await screen.findByText(/^Resolved: Romans 9:1/);
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await screen.findByRole('button', { name: NODE_ADD_COPY.separateCopy });
      return rendered;
    }

    const rerenderAt = (rendered: Awaited<ReturnType<typeof focusExisting>>, revision: number) =>
      rendered.rerender(
        <QueryClientProvider client={rendered.queryClient}>
          <NodesSection study={{ ...STUDY, revision }} onReload={rendered.onReload} />
        </QueryClientProvider>,
      );

    it('Retry after a lost "Add a separate copy" response resends the identical body and key, even after the study moved elsewhere', async () => {
      const rendered = await focusExisting();
      reply(`POST ${NODES}`, new TypeError('connection dropped'));
      fireEvent.click(screen.getByRole('button', { name: NODE_ADD_COPY.separateCopy }));
      const alert = await screen.findByRole('alert');
      expect(textOf(alert)).toBe(`${NODE_ADD_COPY.unknown}Retry`);
      // The study's revision moves somewhere else while the outcome is unknown.
      rerenderAt(rendered, 9);
      reply(
        `POST ${NODES}`,
        jsonResponse(
          201,
          scriptureMutation({
            id: DUPLICATE_ID,
            outcome: 'explicit_duplicate',
            canonicalNodeId: SCRIPTURE_ID,
            studyRevision: 6,
          }),
        ),
      );
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      await screen.findByText(NODE_ADD_COPY.duplicate('Romans 9:1'));
      const [, lost, retried] = posts();
      expect(posts()).toHaveLength(3);
      expect(lost?.body).toStrictEqual(COPY_BODY);
      // Verbatim: the server replays its receipt instead of adding a second duplicate.
      expect(retried?.body).toStrictEqual(lost?.body);
      expect(retried?.key).toBe(lost?.key);
    });

    it('Retry after a lost Create response resends the identical body and key after the study moved elsewhere', async () => {
      reply(`GET ${NODES}`, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
      reply(`POST ${NODES}`, new TypeError('connection dropped'), jsonResponse(201, mutation()));
      const rendered = renderSection();
      await openAdd();
      fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      const alert = await screen.findByRole('alert');
      rendered.rerender(
        <QueryClientProvider client={rendered.queryClient}>
          <NodesSection study={{ ...STUDY, revision: 9 }} onReload={rendered.onReload} />
        </QueryClientProvider>,
      );
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(posts()).toHaveLength(2));
      const [lost, retried] = posts();
      expect(lost?.body).toStrictEqual({ type: 'thought', expectedRevision: 4, text: 'x' });
      expect(retried?.body).toStrictEqual(lost?.body);
      expect(retried?.key).toBe(lost?.key);
    });

    it.each(['STUDY_ARCHIVED', 'STUDY_TRASHED'])(
      'moves focus to the section alert when "Add a separate copy" is refused with %s',
      async (code) => {
        await focusExisting();
        reply(`POST ${NODES}`, jsonResponse(422, envelope(code)));
        const button = screen.getByRole('button', { name: NODE_ADD_COPY.separateCopy });
        button.focus();
        fireEvent.click(button);
        const alert = await screen.findByRole('alert');
        expect(textOf(alert)).toBe(`${NODES_COPY.locked}Reload`);
        await waitFor(() => expect(document.activeElement).toBe(alert));
        expect(screen.queryByRole('button', { name: NODE_ADD_COPY.separateCopy })).toBeNull();
      },
    );

    it('drops the revisit status once another node is selected, and does not bring it back', async () => {
      const other = summary();
      reply(`GET ${NODE}`, jsonResponse(200, { type: 'thought', ...common(), text: 'T' }));
      await focusExisting([existing, other]);
      fireEvent.click(screen.getByRole('button', { name: 'Thought · You Maybe a second witness' }));
      await screen.findByRole('region', { name: 'Thought' });
      expect(screen.queryByRole('button', { name: NODE_ADD_COPY.separateCopy })).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'Scripture · Scripture Text Romans 9:1' }),
      );
      await screen.findByRole('region', { name: 'Scripture' });
      expect(screen.queryByRole('button', { name: NODE_ADD_COPY.separateCopy })).toBeNull();
    });
  });
});
