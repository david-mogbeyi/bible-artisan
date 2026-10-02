import type {
  AnchorSelection,
  Annotation,
  BiblePassageResponse,
  CaptureAnchorResponse,
  ScriptureAnchor,
} from '@bible-artisan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapter, OTHER_TRANSLATION, TRANSLATION } from '@/test/bible-fixtures';
import { NODE_ADD_COPY } from '@/lib/add-node';
import { studyQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { BibleReader } from './bible-reader';
import type { ReaderStudy } from './study-highlights';

/** Synthetic text (AGENTS.md rule 8). */
const PASSAGE_ID = '33333333-2222-4333-8444-555555555555';
const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const HIGHLIGHT_ID = 'cccccccc-2222-4333-8444-555555555555';
const DRIFTED_ID = 'dddddddd-2222-4333-8444-555555555555';
const T = '2026-10-01T12:00:00.000Z';
const SHA = 'b'.repeat(64);
const PASSAGE: BiblePassageResponse = chapter({
  book: { code: 'PSA', name: 'Psalms', chapterCount: 150 },
  chapter: 3,
  verses: [
    { verse: 1, text: 'one two three' },
    { verse: 2, text: 'four five' },
    { verse: 3, text: 'six seven' },
  ],
  superscriptions: [],
  reference: {
    id: PASSAGE_ID,
    editionId: TRANSLATION.id,
    bookCode: 'PSA',
    startChapter: 3,
    startVerse: 1,
    endChapter: 3,
    endVerse: 3,
    label: 'Psalms 3',
  },
});
const ref = (verse: number) => ({
  id: `9999999${verse}-2222-4333-8444-555555555555`,
  editionId: TRANSLATION.id,
  bookCode: 'PSA',
  startChapter: 3,
  startVerse: verse,
  endChapter: 3,
  endVerse: verse,
  label: `Psalms 3:${verse}`,
});
const anchor = (verse: number, start: number, end: number, quote: string): ScriptureAnchor => ({
  version: 1,
  editionId: TRANSLATION.id,
  bookCode: 'PSA',
  kind: 'phrase',
  segments: [{ chapter: 3, verse, start, end, textSha256: SHA }],
  quote,
});
const RESOLVED: Annotation = {
  id: HIGHLIGHT_ID,
  revision: 1,
  colorToken: 'green',
  label: 'Witness',
  resolution: { outcome: 'resolved', anchor: anchor(1, 4, 7, 'two'), reference: ref(1) },
  createdAt: T,
  updatedAt: T,
};
const DRIFTED: Annotation = {
  id: DRIFTED_ID,
  revision: 1,
  colorToken: 'pink',
  label: null,
  resolution: {
    outcome: 'unresolved',
    reason: 'ANCHOR_QUOTE_MISMATCH',
    anchor: anchor(2, 0, 4, 'fourth'),
    reference: ref(2),
  },
  createdAt: T,
  updatedAt: T,
};
const STUDY: ReaderStudy = {
  id: STUDY_ID,
  title: 'Conscience',
  revision: 7,
  lifecycle: 'active',
};
const LIST = `GET /studies/${STUDY_ID}/annotations?referenceId=${PASSAGE_ID}`;

type Reply = Response | ((body: unknown) => Response);
let replies: Map<string, Reply[]>;
let requests: { route: string; body: unknown; key: string | undefined }[];

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
      // Only opaque ids ever travel in a URL: never a quote, label or reference.
      expect(url.search).not.toMatch(/two|Witness|four|Psalms/);
      const route = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const body: unknown = init.body ? JSON.parse(init.body as string) : undefined;
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({ route, body, key: headers['Idempotency-Key'] });
      if (route.startsWith('GET /bible/passages')) {
        return Promise.resolve(jsonResponse(200, PASSAGE));
      }
      if (route === 'POST /bible/anchors') {
        const selection = body as AnchorSelection;
        const verse = selection.segments[0]?.verse ?? 1;
        return Promise.resolve(
          jsonResponse(200, {
            anchor: {
              version: 1,
              ...selection,
              segments: selection.segments.map((s) => ({ ...s, textSha256: SHA })),
            },
            reference: ref(verse),
          } satisfies CaptureAnchorResponse),
        );
      }
      const next = replies.get(route)?.shift();
      if (!next) throw new Error(`unexpected ${route}`);
      return Promise.resolve(typeof next === 'function' ? next(body) : next);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const readerElement = (study: ReaderStudy | null) => (
  <BibleReader
    translations={[TRANSLATION, OTHER_TRANSLATION]}
    editionId={TRANSLATION.id}
    referenceId={PASSAGE_ID}
    onOpenChapter={vi.fn()}
    onOpenReference={vi.fn()}
    onChangeEdition={vi.fn()}
    focusRequest={null}
    study={study}
  />
);

async function renderReader(study: ReaderStudy | null = STUDY) {
  const view = renderWithQuery(readerElement(study));
  await screen.findByRole('heading', { name: 'Psalms 3' });
  return view;
}

const verseText = (verse: number) =>
  document.querySelector(`[data-verse-text="${verse}"]`) as HTMLElement;

describe('highlights in the reader (BIB-24)', () => {
  it('draws a saved highlight over exactly its text, names it, and keeps the verse text exactly as stored', async () => {
    reply(LIST, jsonResponse(200, { items: [RESOLVED, DRIFTED] }));
    await renderReader();

    const list = await screen.findByRole('region', { name: 'Highlights in this chapter' });
    const marks = Array.from(document.querySelectorAll('mark'));
    expect({
      marks: marks.map((mark) => [mark.textContent, mark.className.includes('bg-highlight-green')]),
      verse1: verseText(1).textContent,
      verse2: verseText(2).textContent,
      // Named for screen readers beside the verse, outside the measured text.
      note: textOf(verseText(1).nextElementSibling),
    }).toStrictEqual({
      marks: [['two', true]],
      verse1: 'one two three',
      verse2: 'four five',
      note: '(Green highlight: Witness)',
    });
    // The list names each highlight by reference, color and label: color is never the only signal.
    const items = within(list).getAllByRole('listitem');
    expect(textOf(items[0])).toContain('Psalms 3:1 · Green · Witness');
  });

  it('lists a highlight that no longer matches with its original quote, the reason and Reselect, and never draws it', async () => {
    reply(LIST, jsonResponse(200, { items: [DRIFTED] }));
    await renderReader();
    const list = await screen.findByRole('region', { name: 'Highlights in this chapter' });
    const drifted = within(list).getAllByRole('listitem')[0];
    expect({
      marks: document.querySelectorAll('mark').length,
      text: textOf(drifted),
      quote: textOf(drifted?.querySelector('blockquote')),
      reselect: within(drifted as HTMLElement)
        .getByRole('link', { name: 'Reselect Psalms 3:2' })
        .getAttribute('href'),
    }).toStrictEqual({
      marks: 0,
      text: expect.stringContaining('The saved words no longer match the text.') as string,
      quote: '“fourth”',
      reselect: `/bible?ref=${ref(2).id}&study=${STUDY_ID}`,
    });
  });

  it('saves a highlight by keyboard: tick a verse, Capture, Highlight, choose a color and label, Save', async () => {
    reply(LIST, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [RESOLVED] }));
    reply(
      `POST /studies/${STUDY_ID}/annotations`,
      jsonResponse(201, {
        id: HIGHLIGHT_ID,
        studyId: STUDY_ID,
        revision: 1,
        colorToken: 'blue',
        referenceId: ref(3).id,
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
        lastEventSequence: '9',
        studyRevision: 8,
      }),
    );
    await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));

    const form = screen.getByRole('form', { name: 'Highlight this selection' });
    // Focus moves into the form, onto the first color.
    expect(document.activeElement).toBe(within(form).getByRole('radio', { name: 'Yellow' }));
    fireEvent.click(within(form).getByRole('radio', { name: 'Blue' }));
    fireEvent.change(within(form).getByLabelText('Label (optional)'), {
      target: { value: '  Seven ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save highlight' }));

    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain('Blue highlight saved on Psalms 3:3.'),
    );
    const post = requests.find((r) => r.route === `POST /studies/${STUDY_ID}/annotations`);
    expect(post).toStrictEqual({
      route: `POST /studies/${STUDY_ID}/annotations`,
      body: {
        expectedRevision: 7,
        anchor: {
          version: 1,
          editionId: TRANSLATION.id,
          bookCode: 'PSA',
          kind: 'verses',
          segments: [{ chapter: 3, verse: 3, start: 0, end: 9, textSha256: SHA }],
          quote: 'six seven',
        },
        colorToken: 'blue',
        label: '  Seven ',
      },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    });
    // The saved highlight shows after the list reloads; focus returns to Highlight.
    expect(await screen.findByText('two')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Highlight' }));
  });

  /** Captures verse 3 and opens the Highlight form with Blue and a label chosen. */
  async function chooseHighlight() {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));
    const form = screen.getByRole('form', { name: 'Highlight this selection' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Blue' }));
    fireEvent.change(within(form).getByLabelText('Label (optional)'), {
      target: { value: 'Seven' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save highlight' }));
    return form;
  }
  const created = () =>
    jsonResponse(201, {
      id: HIGHLIGHT_ID,
      studyId: STUDY_ID,
      revision: 1,
      colorToken: 'blue',
      referenceId: ref(3).id,
      createdAt: T,
      updatedAt: T,
      deletedAt: null,
      lastEventSequence: '9',
      studyRevision: 10,
    });
  const posts = () => requests.filter((r) => r.route === `POST /studies/${STUDY_ID}/annotations`);

  it('after a study conflict reads the study again and Retry saves the same choice on its current revision, with a new key', async () => {
    reply(LIST, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(
      `POST /studies/${STUDY_ID}/annotations`,
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'c',
        currentRevision: 9,
      }),
      created(),
    );
    const studyAt = (revision: number) => ({
      id: STUDY_ID,
      title: 'Conscience',
      description: null,
      lifecycle: 'active',
      pinned: false,
      revision,
      contentRevision: 5,
      startingReference: null,
      mainQuestion: null,
      originalQuestion: null,
      tags: [],
      branchId: null,
      purgeAt: null,
      createdAt: T,
    });
    reply(`GET /studies/${STUDY_ID}`, jsonResponse(200, studyAt(9)));
    const view = await renderReader();
    // As in the app (providers.tsx): a cached study counts as fresh for 30 s, so the re-read
    // after a 409 must still go to the server.
    view.queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    view.queryClient.setQueryData(studyQueryKey(STUDY_ID), studyAt(7));
    const form = await chooseHighlight();

    const alert = await within(form).findByRole('alert');
    expect(textOf(alert)).toContain('This study changed somewhere else');
    // The study was read again; the choice is still in the form.
    expect(requests.some((r) => r.route === `GET /studies/${STUDY_ID}`)).toBe(true);
    expect(within(form).getByRole<HTMLInputElement>('radio', { name: 'Blue' }).checked).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(
      () =>
        expect(textOf(screen.getByRole('status'))).toContain('Blue highlight saved on Psalms 3:3.'),
      { timeout: 3000 },
    );
    const [first, second] = posts();
    expect({
      revisions: posts().map((p) => (p.body as { expectedRevision: number }).expectedRevision),
      intents: posts().map((p) => {
        const { colorToken, label } = p.body as { colorToken: string; label: string };
        return [colorToken, label];
      }),
      newKey: first?.key !== second?.key,
    }).toStrictEqual({
      revisions: [7, 9],
      intents: [
        ['blue', 'Seven'],
        ['blue', 'Seven'],
      ],
      newKey: true,
    });
  });

  it('keeps the Idempotency-Key for Retry when the server marks a failure retryable, whatever its status', async () => {
    reply(LIST, jsonResponse(200, { items: [] }), jsonResponse(200, { items: [] }));
    reply(
      `POST /studies/${STUDY_ID}/annotations`,
      jsonResponse(422, {
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'x',
        retryable: true,
        correlationId: 'c',
      }),
      created(),
    );
    await renderReader();
    const form = await chooseHighlight();
    fireEvent.click(await within(form).findByRole('button', { name: 'Retry' }));
    await waitFor(
      () =>
        expect(textOf(screen.getByRole('status'))).toContain('Blue highlight saved on Psalms 3:3.'),
      { timeout: 3000 },
    );
    const [first, second] = posts();
    expect([posts().length, first?.body, first?.key]).toStrictEqual([2, second?.body, second?.key]);
  });

  it('deletes a highlight after a labelled confirmation with focus on Cancel; a conflict offers Reload', async () => {
    reply(LIST, jsonResponse(200, { items: [RESOLVED] }), jsonResponse(200, { items: [] }));
    reply(
      `DELETE /studies/${STUDY_ID}/annotations/${HIGHLIGHT_ID}`,
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'c',
        currentRevision: 2,
      }),
    );
    await renderReader();
    const list = await screen.findByRole('region', { name: 'Highlights in this chapter' });
    fireEvent.click(within(list).getByRole('button', { name: 'Delete Green highlight: Witness' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this highlight?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete highlight' }));

    expect(textOf(await screen.findByRole('alert'))).toContain(
      'This highlight changed somewhere else, so nothing was saved.',
    );
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(requests.at(-1)).toStrictEqual({
      route: `DELETE /studies/${STUDY_ID}/annotations/${HIGHLIGHT_ID}`,
      body: { expectedRevision: 1 },
      key: expect.any(String) as string,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload highlights' }));
    await waitFor(() => expect(document.querySelectorAll('mark')).toHaveLength(0));
  });

  it('edits color and label from the list keeping focus on Edit, and a delete moves focus to the list heading', async () => {
    const mutated = (revision: number, deletedAt: string | null) =>
      jsonResponse(200, {
        id: HIGHLIGHT_ID,
        studyId: STUDY_ID,
        revision,
        colorToken: 'pink',
        referenceId: ref(1).id,
        createdAt: T,
        updatedAt: T,
        deletedAt,
        lastEventSequence: '9',
      });
    reply(
      LIST,
      jsonResponse(200, { items: [RESOLVED] }),
      jsonResponse(200, {
        items: [{ ...RESOLVED, revision: 2, colorToken: 'pink', label: null }],
      }),
      jsonResponse(200, { items: [] }),
    );
    reply(`PATCH /studies/${STUDY_ID}/annotations/${HIGHLIGHT_ID}`, mutated(2, null));
    reply(`DELETE /studies/${STUDY_ID}/annotations/${HIGHLIGHT_ID}`, mutated(3, T));
    await renderReader();
    const list = await screen.findByRole('region', { name: 'Highlights in this chapter' });
    fireEvent.click(within(list).getByRole('button', { name: 'Edit Green highlight: Witness' }));
    const form = within(list).getByRole('form', { name: 'Edit Green highlight: Witness' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Pink' }));
    fireEvent.change(within(form).getByLabelText('Label (optional)'), { target: { value: ' ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    const edit = await within(list).findByRole('button', { name: 'Edit Pink highlight' });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(requests.find((r) => r.route.startsWith('PATCH'))?.body).toStrictEqual({
      expectedRevision: 1,
      colorToken: 'pink',
      label: null,
    });

    fireEvent.click(within(list).getByRole('button', { name: 'Delete Pink highlight' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete highlight' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Highlights in this chapter' }),
      ),
    );
    expect(await screen.findByText('No highlights in this chapter yet.')).toBeTruthy();
  });

  it('shows highlights read-only in an archived study, with no way to add or change them', async () => {
    reply(LIST, jsonResponse(200, { items: [RESOLVED] }));
    await renderReader({ ...STUDY, lifecycle: 'archived' });
    const list = await screen.findByRole('region', { name: 'Highlights in this chapter' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    expect(
      await screen.findByText(/This study is archived, so new highlights and notes can’t be added/),
    ).toBeTruthy();
    expect({
      highlight: screen.queryByRole('button', { name: 'Highlight' }),
      edit: within(list).queryByRole('button', { name: /^Edit/ }),
    }).toStrictEqual({ highlight: null, edit: null });
  });

  it('outside a study asks for no highlights and offers no highlight actions', async () => {
    await renderReader(null);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/Captured\./);
    expect({
      region: screen.queryByRole('region', { name: 'Highlights in this chapter' }),
      highlight: screen.queryByRole('button', { name: 'Highlight' }),
      requests: requests.filter((r) => r.route.includes('/annotations')),
    }).toStrictEqual({ region: null, highlight: null, requests: [] });
  });
});

describe('Add to study in the reader (BIB-26)', () => {
  const NODES = `POST /studies/${STUDY_ID}/nodes`;
  const NODE_ID = 'eeeeeeee-2222-4333-8444-555555555555';
  const COPY_ID = 'ffffffff-2222-4333-8444-555555555555';
  const nodePosts = () => requests.filter((r) => r.route === NODES);
  const answer = (status: number, overrides: Record<string, unknown>) =>
    jsonResponse(status, {
      id: NODE_ID,
      studyId: STUDY_ID,
      type: 'scripture',
      origin: 'scripture',
      revision: 1,
      referenceId: ref(3).id,
      createdAt: T,
      updatedAt: T,
      lastEventSequence: '9',
      studyRevision: 8,
      outcome: 'created',
      canonicalNodeId: null,
      ...overrides,
    });

  /** Ticks verse 3, captures it, and returns the focused Add to study button. */
  let view: Awaited<ReturnType<typeof renderReader>>;
  /** The same reader, now given `study` (e.g. a revision that moved elsewhere). */
  const rerenderReader = (study: ReaderStudy) =>
    view.rerender(
      <QueryClientProvider client={view.queryClient}>{readerElement(study)}</QueryClientProvider>,
    );

  async function captureVerse3() {
    reply(LIST, jsonResponse(200, { items: [] }));
    view = await renderReader();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    const button = await screen.findByRole('button', { name: 'Add to study' });
    button.focus();
    return button;
  }

  it('adds the captured passage by keyboard, announces it and links to the node in the study', async () => {
    reply(NODES, answer(201, {}));
    const button = await captureVerse3();
    fireEvent.click(button);
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain('Added Psalms 3:3 to the study.'),
    );
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('link', { name: 'Show in study' }).getAttribute('href')).toBe(
      `/studies/${STUDY_ID}?node=${NODE_ID}`,
    );
    expect(nodePosts()).toStrictEqual([
      {
        route: NODES,
        body: { type: 'scripture', referenceId: ref(3).id, expectedRevision: 7 },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
  });

  it('says a passage already in the study was focused and its visit recorded, and adds a separate copy on request', async () => {
    reply(
      NODES,
      answer(200, { outcome: 'focused_existing' }),
      answer(201, {
        id: COPY_ID,
        outcome: 'explicit_duplicate',
        canonicalNodeId: NODE_ID,
        studyRevision: 9,
      }),
    );
    const button = await captureVerse3();
    fireEvent.click(button);
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain(
        'Psalms 3:3 is already in this study. Your visit was recorded.',
      ),
    );
    expect(screen.getByRole('link', { name: 'Show in study' }).getAttribute('href')).toBe(
      `/studies/${STUDY_ID}?node=${NODE_ID}`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add a separate copy' }));
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain('Added a duplicate of Psalms 3:3.'),
    );
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole('button', { name: 'Add a separate copy' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Show in study' }).getAttribute('href')).toBe(
      `/studies/${STUDY_ID}?node=${COPY_ID}`,
    );
    const [first, second] = nodePosts();
    expect({
      bodies: [first?.body, second?.body],
      newKey: first?.key !== second?.key,
    }).toStrictEqual({
      bodies: [
        { type: 'scripture', referenceId: ref(3).id, expectedRevision: 7 },
        {
          type: 'scripture',
          referenceId: ref(3).id,
          // The study revision the first Add moved to.
          expectedRevision: 8,
          duplicatePolicy: 'explicit_duplicate',
        },
      ],
      newKey: true,
    });
  });

  it('after a study conflict reads the study again and asks to press Add to study again, which sends the current revision with a new key', async () => {
    reply(
      NODES,
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'c',
        currentRevision: 9,
      }),
      answer(200, { outcome: 'focused_existing', studyRevision: 10 }),
    );
    reply(
      `GET /studies/${STUDY_ID}`,
      jsonResponse(200, {
        id: STUDY_ID,
        title: 'Conscience',
        description: null,
        lifecycle: 'active',
        pinned: false,
        revision: 9,
        contentRevision: 5,
        startingReference: null,
        mainQuestion: null,
        originalQuestion: null,
        tags: [],
        branchId: null,
        purgeAt: null,
        createdAt: T,
      }),
    );
    const button = await captureVerse3();
    fireEvent.click(button);
    expect(textOf(await screen.findByRole('alert'))).toBe(NODE_ADD_COPY.conflict('Add to study'));
    fireEvent.click(button);
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain('Your visit was recorded.'),
    );
    const [first, second] = nodePosts();
    expect({
      revisions: nodePosts().map((p) => (p.body as { expectedRevision: number }).expectedRevision),
      newKey: first?.key !== second?.key,
    }).toStrictEqual({ revisions: [7, 9], newKey: true });
  });

  it('retries an unknown outcome with the same Idempotency-Key and body', async () => {
    reply(
      NODES,
      jsonResponse(503, {
        code: 'TRANSIENT_CONFLICT',
        message: 'x',
        retryable: true,
        correlationId: 'c',
      }),
      answer(201, {}),
    );
    const button = await captureVerse3();
    fireEvent.click(button);
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain('Added Psalms 3:3 to the study.'),
    );
    const [first, second] = nodePosts();
    expect([second?.key === first?.key, second?.body]).toStrictEqual([true, first?.body]);
  });

  it('Retry after a lost "Add a separate copy" response resends the identical body and key after the study moved elsewhere, so no second duplicate', async () => {
    reply(
      NODES,
      answer(200, { outcome: 'focused_existing' }),
      jsonResponse(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: 'x',
        retryable: true,
        correlationId: 'c',
      }),
      answer(201, {
        id: COPY_ID,
        outcome: 'explicit_duplicate',
        canonicalNodeId: NODE_ID,
        studyRevision: 9,
      }),
    );
    const button = await captureVerse3();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: NODE_ADD_COPY.separateCopy }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain(NODE_ADD_COPY.unknown);
    // The study moved somewhere else while the outcome was unknown.
    rerenderReader({ ...STUDY, revision: 12 });
    fireEvent.click(
      within(await screen.findByRole('alert')).getByRole('button', { name: 'Retry' }),
    );
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toContain(NODE_ADD_COPY.duplicate('Psalms 3:3')),
    );
    const [, lost, retried] = nodePosts();
    expect(nodePosts()).toHaveLength(3);
    expect(lost?.body).toStrictEqual({
      type: 'scripture',
      referenceId: ref(3).id,
      expectedRevision: 8,
      duplicatePolicy: 'explicit_duplicate',
    });
    expect(retried).toStrictEqual(lost);
  });

  it('says a phrase adds the verse containing it', async () => {
    reply(LIST, jsonResponse(200, { items: [] }));
    await renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'Select a phrase' }));
    const form = screen.getByRole('form', { name: 'Select a phrase' });
    fireEvent.click(within(form).getByRole('button', { name: 'Select phrase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    const button = await screen.findByRole('button', { name: 'Add to study' });
    const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(textOf(hint)).toBe('Adds Psalms 3:1 (the verse containing your phrase)');
  });

  it('offers no Add to study in an archived study or outside a study', async () => {
    reply(LIST, jsonResponse(200, { items: [] }));
    const view = await renderReader({ ...STUDY, lifecycle: 'archived' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/This study is archived/);
    expect(screen.queryByRole('button', { name: 'Add to study' })).toBeNull();
    view.unmount();

    await renderReader(null);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select verse 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/Captured\./);
    expect(screen.queryByRole('button', { name: 'Add to study' })).toBeNull();
    expect(nodePosts()).toStrictEqual([]);
  });
});
