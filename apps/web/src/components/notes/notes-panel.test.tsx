import {
  EMPTY_NOTE_DOCUMENT,
  type NoteDocument,
  noteDocumentSchema,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteQueryKey } from '@/lib/notes';
import { TRANSLATION } from '@/test/bible-fixtures';
import { studyQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { INVALID_COPY, SAVE_COPY } from './note-editor';
import { NOTES_COPY, NotesPanel } from './notes-panel';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NOTE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const QUESTION_ID = 'dddddddd-2222-4333-8444-555555555555';
const STUDY: StudyResponse = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 4,
  contentRevision: 3,
  startingReference: null,
  mainQuestion: { nodeId: QUESTION_ID, text: 'What is conscience?', status: 'open' },
  originalQuestion: { nodeId: QUESTION_ID, text: 'What is conscience?', status: 'open' },
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};
const T = '2026-10-01T12:00:00.000Z';
const THOUGHT_ID = 'cccccccc-2222-4333-8444-555555555555';
/** The study's live nodes (BIB-25), answered for every node list read unless a test queues one. */
const NODE_LIST = {
  items: [
    {
      id: QUESTION_ID,
      type: 'question',
      origin: 'user',
      label: 'What is conscience?',
      status: 'open',
      observationKind: null,
      referenceId: null,
      canonicalNodeId: null,
      revision: 1,
      createdAt: T,
      updatedAt: T,
    },
    {
      id: THOUGHT_ID,
      type: 'thought',
      origin: 'user',
      label: `A second witness ${'x'.repeat(100)}`,
      status: null,
      observationKind: null,
      referenceId: null,
      canonicalNodeId: null,
      revision: 1,
      createdAt: T,
      updatedAt: T,
    },
  ],
};

const doc = (text: string): NoteDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const summary = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  revision: 1,
  target: null,
  preview: 'First thoughts',
  characterCount: 14,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  ...overrides,
});
const note = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  studyId: STUDY_ID,
  revision: 1,
  target: null,
  targetAnchor: null,
  content: doc('First thoughts'),
  characterCount: 14,
  latestVersionNumber: 1,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  ...overrides,
});
const mutation = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  studyId: STUDY_ID,
  revision: 2,
  targetNodeId: null,
  targetReferenceId: null,
  characterCount: 14,
  latestVersionNumber: 1,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  lastEventSequence: '9',
  ...overrides,
});

type Reply = Response | Error | Promise<Response>;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown; key: string | undefined }[];

/** Queues the next answer for `METHOD path` (path relative to /v1, query string included). */
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
      const queue = replies.get(`${method} ${path}`);
      const next = queue?.shift();
      if (!next && method === 'GET' && path === `/studies/${STUDY_ID}/nodes`) {
        return Promise.resolve(jsonResponse(200, NODE_LIST));
      }
      if (!next) throw new Error(`unexpected ${method} ${path}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOTES = `/studies/${STUDY_ID}/notes`;
const NOTE = `${NOTES}/${NOTE_ID}`;

function renderPanel(study: StudyResponse = STUDY) {
  const unsaved = vi.fn();
  const rendered = renderWithQuery(
    <NotesPanel study={study} onReload={() => Promise.resolve()} onUnsavedChange={unsaved} />,
  );
  rendered.queryClient.setQueryData(studyQueryKey(STUDY_ID), study);
  return { ...rendered, unsaved };
}

/** The Tiptap editor behind the labelled text box (Tiptap exposes it on its DOM node). */
async function noteEditor(): Promise<Editor> {
  const box = await screen.findByRole('textbox', { name: 'Note text' });
  const editor = (box as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error('no editor on the text box');
  return editor;
}

/** Types by replacing the document, as the user's keystrokes would, firing the update. */
function typeText(editor: Editor, text: string) {
  act(() => {
    editor.commands.setContent(doc(text), { emitUpdate: true });
  });
}

const saveStatus = () =>
  within(screen.getByRole('region', { name: 'Note editor' })).getAllByRole('status')[0];

describe('NotesPanel (BIB-23)', () => {
  it('creates a note on the main question, focuses its editor, autosaves after typing stops and says Saved only after the 200', async () => {
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, { items: [] }),
      jsonResponse(200, { items: [summary()] }),
    );
    reply(`POST ${NOTES}`, jsonResponse(201, { ...mutation({ revision: 1 }), studyRevision: 5 }));
    reply(
      `GET ${NOTE}`,
      jsonResponse(200, note({ content: EMPTY_NOTE_DOCUMENT, characterCount: 0 })),
    );
    let answer: (response: Response) => void = () => undefined;
    reply(`PATCH ${NOTE}`, new Promise<Response>((resolve) => (answer = resolve)));
    const { queryClient } = renderPanel();

    expect(await screen.findByText(NOTES_COPY.empty)).toBeTruthy();
    // BIB-25: every live node of the study, by type and label, the main question marked.
    await screen.findByRole('option', { name: 'Question: What is conscience? (main question)' });
    expect(
      within(screen.getByLabelText('Attach to'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toStrictEqual([
      'This study',
      'Question: What is conscience? (main question)',
      `Thought: A second witness ${'x'.repeat(53)}…`,
    ]);
    fireEvent.change(screen.getByLabelText('Attach to'), { target: { value: QUESTION_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    const editor = await noteEditor();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({
      body: { expectedRevision: 4, content: EMPTY_NOTE_DOCUMENT, targetNodeId: QUESTION_ID },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Creating a note moved the study's revision; the cached study follows.
    expect(queryClient.getQueryData<StudyResponse>(studyQueryKey(STUDY_ID))?.revision).toBe(5);
    expect(screen.getByText('0 / 50,000 characters')).toBeTruthy();

    typeText(editor, 'Bears witness');
    expect(textOf(saveStatus())).toContain(SAVE_COPY.pending);
    expect(screen.getByText('13 / 50,000 characters')).toBeTruthy();
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saving), {
      timeout: 2000,
    });
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, content: doc('Bears witness') },
    ]);
    // Not acknowledged yet: never "Saved".
    expect(textOf(saveStatus())).not.toContain(SAVE_COPY.saved);
    answer(jsonResponse(200, mutation({ revision: 2, characterCount: 13 })));
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));
  });

  it('keeps the draft through a failed save and Retry resends the identical request with the same key', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(`PATCH ${NOTE}`, new TypeError('offline'), jsonResponse(200, mutation()));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    typeText(editor, 'Second thoughts');
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.failed), {
      timeout: 2000,
    });
    expect(editor.getText()).toBe('Second thoughts');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));
    const patches = requests.filter((r) => r.method === 'PATCH');
    expect([patches[1]?.body, patches[1]?.key]).toStrictEqual([patches[0]?.body, patches[0]?.key]);
  });

  it('keeps the draft on a conflict, and Keep mine saves it as a new version on the current revision', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(
      `GET ${NOTE}`,
      jsonResponse(200, note()),
      jsonResponse(200, note({ revision: 7, content: doc('Theirs') })),
    );
    reply(
      `PATCH ${NOTE}`,
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'x',
        currentRevision: 7,
      }),
      jsonResponse(200, mutation({ revision: 8, latestVersionNumber: 2 })),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    typeText(editor, 'Mine');
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.conflict), {
      timeout: 2000,
    });
    expect(editor.getText()).toBe('Mine');
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));
    const patches = requests.filter((r) => r.method === 'PATCH');
    expect(patches[1]?.body).toStrictEqual({
      expectedRevision: 7,
      content: doc('Mine'),
      checkpoint: true,
    });
    expect(patches[1]?.key).not.toBe(patches[0]?.key);
  });

  it('shows the limit, sends nothing and keeps the draft over 50,000 characters', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    typeText(editor, 'a'.repeat(50_001));
    expect(textOf(saveStatus())).toContain(SAVE_COPY.tooLong);
    expect(screen.getByText('50,001 / 50,000 characters')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(requests.filter((r) => r.method === 'PATCH')).toStrictEqual([]);
    expect(editor.getText()).toHaveLength(50_001);
  });

  it('offers the formatting toolbar by name and toggles bold with its pressed state', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual([
      'Bold',
      'Italic',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'Quote',
      'Link',
      'Resolve reference',
      'Undo',
      'Redo',
    ]);
    act(() => {
      editor.commands.selectAll();
    });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Bold' }));
    await waitFor(() =>
      expect(
        within(toolbar).getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    // A link must be an http(s) address.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Link' }));
    fireEvent.change(screen.getByLabelText('Link address'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));
    expect(textOf(screen.getByRole('alert'))).toContain('Enter a full web address');
    expect(editor.getHTML()).not.toContain('javascript:');
  });

  it('groups orphaned notes with their deleted target, and restores a note from the note trash', async () => {
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, {
        items: [
          summary(),
          summary({
            id: 'cccccccc-2222-4333-8444-555555555555',
            preview: 'About the old question',
            target: {
              kind: 'node',
              nodeId: QUESTION_ID,
              nodeType: 'question',
              label: 'Who bears witness?',
              deleted: true,
            },
          }),
        ],
      }),
      jsonResponse(200, { items: [summary()] }),
    );
    const trashedNote = summary({
      id: 'eeeeeeee-2222-4333-8444-555555555555',
      preview: 'Thrown away',
      revision: 2,
      deletedAt: T,
    });
    reply(
      `GET ${NOTES}?state=trashed`,
      jsonResponse(200, { items: [trashedNote] }),
      jsonResponse(200, { items: [] }),
    );
    reply(
      `POST ${NOTES}/${trashedNote.id}/restore`,
      jsonResponse(200, mutation({ id: trashedNote.id, revision: 3 })),
    );
    renderPanel();

    const orphaned = await screen.findByRole('list', { name: 'Orphaned notes' });
    expect(within(orphaned).getByRole('button', { name: 'About the old question' })).toBeTruthy();
    expect(textOf(orphaned.parentElement)).toContain(NOTES_COPY.orphanedHelp);
    expect(textOf(orphaned)).toContain('On the question: Who bears witness?');
    expect(
      within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('listitem'),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Note trash' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore note: Thrown away' }));
    await waitFor(() => expect(screen.getByText(NOTES_COPY.trashEmpty)).toBeTruthy());
    expect(requests.find((r) => r.path.endsWith('/restore'))).toMatchObject({
      method: 'POST',
      body: { expectedRevision: 2 },
    });
  });

  it('shows notes read-only in an archived study, with safe links and no editor', async () => {
    const linked: NoteDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'source',
              marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
            },
          ],
        },
      ],
    };
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary({ preview: 'source' })] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note({ content: linked })));
    renderPanel({ ...STUDY, lifecycle: 'archived' });
    expect(await screen.findByText(NOTES_COPY.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New note' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'source' }));
    const content = await screen.findByRole('document', { name: 'Note' });
    expect(within(content).getByRole('link', { name: 'source' }).getAttribute('rel')).toBe(
      'noopener noreferrer nofollow',
    );
    expect(screen.queryByRole('textbox', { name: 'Note text' })).toBeNull();
  });

  it('refuses a note whose content fails the allowlist when it arrives from the API', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(
      `GET ${NOTE}`,
      jsonResponse(
        200,
        note({
          content: {
            type: 'doc',
            content: [{ type: 'html', content: '<img src=x onerror=alert(1)>' }],
          },
        }),
      ),
    );
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    expect(await screen.findByText("Couldn't open this note.")).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
  const OTHER_ID = 'ffffffff-2222-4333-8444-555555555555';
  const OTHER = `${NOTES}/${OTHER_ID}`;
  const patches = () => requests.filter((r) => r.method === 'PATCH');

  it('reopening a saved note within the cache time shows the saved text, and the next save builds on its revision', async () => {
    const afterSave = summary({ revision: 2, preview: 'Second thoughts' });
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, { items: [summary()] }),
      // Refreshed after the save and after closing.
      jsonResponse(200, { items: [afterSave] }),
      jsonResponse(200, { items: [afterSave] }),
    );
    // Fetched once: the reopened note comes from the cache (30 s, as in the app).
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(
      `PATCH ${NOTE}`,
      jsonResponse(200, mutation({ revision: 2 })),
      jsonResponse(200, mutation({ revision: 3 })),
    );
    const { queryClient } = renderPanel();
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    typeText(await noteEditor(), 'Second thoughts');
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 2000 });
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));

    fireEvent.click(screen.getByRole('button', { name: 'Close note' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Note editor' })).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Second thoughts' }));
    const reopened = await noteEditor();
    expect(reopened.getText()).toBe('Second thoughts');

    typeText(reopened, 'Third thoughts');
    await waitFor(() => expect(patches()).toHaveLength(2), { timeout: 2000 });
    expect(patches()[1]?.body).toStrictEqual({
      expectedRevision: 2,
      content: doc('Third thoughts'),
    });
    expect(requests.filter((r) => r.method === 'GET' && r.path === NOTE)).toHaveLength(1);
  });

  it('shows a newer copy of the open note when nothing is unsaved, and saves from its revision', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation({ revision: 6 })));
    const { queryClient } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    act(() => {
      queryClient.setQueryData(
        noteQueryKey(STUDY_ID, NOTE_ID),
        note({ revision: 5, content: doc('Saved elsewhere') }),
      );
    });
    await waitFor(() => expect(editor.getText()).toBe('Saved elsewhere'));
    // An older copy never replaces it.
    act(() => {
      queryClient.setQueryData(noteQueryKey(STUDY_ID, NOTE_ID), note());
    });
    expect(editor.getText()).toBe('Saved elsewhere');
    typeText(editor, 'Saved elsewhere, then here');
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 2000 });
    expect(patches()[0]?.body).toStrictEqual({
      expectedRevision: 5,
      content: doc('Saved elsewhere, then here'),
    });
  });

  it('opening another note saves the open one first, keeping it unsaved until the save commits', async () => {
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, {
        items: [summary(), summary({ id: OTHER_ID, preview: 'Other note' })],
      }),
    );
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(`GET ${OTHER}`, jsonResponse(200, note({ id: OTHER_ID, content: doc('Other note') })));
    let answer: (response: Response) => void = () => undefined;
    reply(`PATCH ${NOTE}`, new Promise<Response>((resolve) => (answer = resolve)));
    const { unsaved } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    typeText(await noteEditor(), 'Unsaved words');

    // Before the idle delay: switching sends the draft at once, and waits for it.
    fireEvent.click(screen.getByRole('button', { name: 'Other note' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toStrictEqual({
      expectedRevision: 1,
      content: doc('Unsaved words'),
    });
    expect((await noteEditor()).getText()).toBe('Unsaved words');
    expect(unsaved.mock.lastCall).toStrictEqual([true]);
    expect(requests.some((r) => r.path === OTHER)).toBe(false);

    answer(jsonResponse(200, mutation({ revision: 2 })));
    await waitFor(async () => expect((await noteEditor()).getText()).toBe('Other note'));
    expect(unsaved.mock.lastCall).toStrictEqual([false]);
  });

  it('keeps a note that cannot be saved open, says why, and neither switches nor creates', async () => {
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, {
        items: [summary(), summary({ id: OTHER_ID, preview: 'Other note' })],
      }),
    );
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    const { unsaved } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    typeText(editor, 'a'.repeat(50_001));

    fireEvent.click(screen.getByRole('button', { name: 'Other note' }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain(SAVE_COPY.closeBlocked);
    expect(textOf(alert)).toContain(SAVE_COPY.tooLong);
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.filter((r) => r.method !== 'GET' || r.path === OTHER)).toStrictEqual([]);
    expect(editor.getText()).toHaveLength(50_001);
    expect(unsaved.mock.lastCall).toStrictEqual([true]);

    // Leaving without saving is an explicit choice.
    fireEvent.click(
      within(await screen.findByRole('alert')).getByRole('button', {
        name: 'Close without saving',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Note editor' })).toBeNull());
    expect(patches()).toStrictEqual([]);
  });

  it('keeps the note open when the save made on switching fails', async () => {
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, {
        items: [summary(), summary({ id: OTHER_ID, preview: 'Other note' })],
      }),
    );
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(`PATCH ${NOTE}`, new TypeError('offline'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    typeText(await noteEditor(), 'Fragile words');
    fireEvent.click(screen.getByRole('button', { name: 'Other note' }));
    expect(textOf(await screen.findByRole('alert'))).toContain(SAVE_COPY.closeFailed);
    expect((await noteEditor()).getText()).toBe('Fragile words');
    expect(requests.some((r) => r.path === OTHER)).toBe(false);
  });

  it('does not serialize or validate the document on a keystroke, only when it saves', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note()));
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation()));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    const parse = vi.spyOn(noteDocumentSchema, 'safeParse');
    try {
      for (const text of ['S', 'Se', 'Sec', 'Seco', 'Second']) typeText(editor, text);
      expect(parse).not.toHaveBeenCalled();
      expect(screen.getByText('6 / 50,000 characters')).toBeTruthy();
      await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 2000 });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('saves pasted text with control characters as spaces, pasted HTML without images or scripts, and a list typed as "0. "', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note({ content: EMPTY_NOTE_DOCUMENT })));
    reply(
      `PATCH ${NOTE}`,
      jsonResponse(200, mutation({ revision: 2 })),
      jsonResponse(200, mutation({ revision: 3 })),
      jsonResponse(200, mutation({ revision: 4 })),
    );
    // jsdom has no ClipboardEvent; ProseMirror's programmatic paste makes one.
    vi.stubGlobal(
      'ClipboardEvent',
      class extends Event {
        readonly clipboardData = null;
      },
    );
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    const saveNext = async (count: number) =>
      waitFor(() => expect(patches()).toHaveLength(count), { timeout: 2000 });

    act(() => {
      editor.commands.selectAll();
      editor.view.pasteText('tab\there\vvertical\fform feed');
    });
    await saveNext(1);
    expect(patches()[0]?.body).toStrictEqual({
      expectedRevision: 1,
      content: doc('tab\there vertical form feed'),
    });
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));

    act(() => {
      editor.commands.selectAll();
      editor.view.pasteHTML(
        '<p>Kept<img src="x" onerror="alert(1)"><script>alert(1)</script> <s>text</s></p>',
      );
    });
    await saveNext(2);
    expect(patches()[1]?.body).toStrictEqual({ expectedRevision: 2, content: doc('Kept text') });
    expect(container.querySelector('img, script')).toBeNull();
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved));

    act(() => {
      editor.commands.setContent(EMPTY_NOTE_DOCUMENT, { emitUpdate: false });
      editor.commands.insertContent('0. ', { applyInputRules: true });
      editor.commands.insertContent('first');
    });
    // The input rule numbered the list from 0, which the server refuses; it is saved from 1.
    await waitFor(() =>
      expect(editor.getJSON().content?.[0]).toMatchObject({
        type: 'orderedList',
        attrs: { start: 0 },
      }),
    );
    await saveNext(3);
    expect(patches()[2]?.body).toStrictEqual({
      expectedRevision: 3,
      content: {
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
              },
            ],
          },
          { type: 'paragraph' },
        ],
      },
    });
    expect(Object.values(INVALID_COPY).some((copy) => textOf(saveStatus()).includes(copy))).toBe(
      false,
    );
  });
});

describe('Bible references and passages in notes (BIB-24)', () => {
  const ROMANS = {
    id: 'eeeeeeee-2222-4333-8444-555555555555',
    editionId: TRANSLATION.id,
    bookCode: 'ROM',
    startChapter: 9,
    startVerse: 1,
    endChapter: 9,
    endVerse: 1,
    label: 'Romans 9:1',
  };
  /** Selects `text` inside the editor's first paragraph (the user's selection). */
  function select(editor: Editor, text: string) {
    const start = editor.state.doc.textContent.indexOf(text);
    act(() => {
      editor.commands.setTextSelection({ from: start + 1, to: start + 1 + text.length });
    });
  }
  const linked = (before: string, after: string): NoteDocument => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: before },
          { type: 'scriptureReference', attrs: { referenceId: ROMANS.id, label: ROMANS.label } },
          { type: 'text', text: after },
        ],
      },
    ],
  });

  async function openNote(text: string) {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note({ content: doc(text) })));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    return noteEditor();
  }
  const resolveStatus = () =>
    within(screen.getByRole('region', { name: 'Note editor' })).getAllByRole('status')[1];

  it('resolves the selected reference into a verified link, saves it, and asks nothing else of the study', async () => {
    reply('GET /bible/translations', jsonResponse(200, { translations: [TRANSLATION] }));
    reply('POST /bible/resolve', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation()));
    const editor = await openNote('See Rom 9:1 now');
    select(editor, 'Rom 9:1');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve reference' }));

    await waitFor(() => expect(textOf(resolveStatus())).toContain('Linked Romans 9:1.'));
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved), {
      timeout: 3000,
    });
    expect(
      requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.body]),
    ).toStrictEqual([
      // The typed text and edition travel in the body only.
      ['POST', '/bible/resolve', { input: 'Rom 9:1', editionId: TRANSLATION.id }],
      ['PATCH', NOTE, { expectedRevision: 1, content: linked('See ', ' now') }],
    ]);
    // The editor shows the canonical label as one unit.
    expect(textOf(screen.getByRole('textbox', { name: 'Note text' }))).toContain(
      'See Romans 9:1 now',
    );
  });

  it('links only the reference when the selection has spaces around it, keeping those spaces', async () => {
    reply('GET /bible/translations', jsonResponse(200, { translations: [TRANSLATION] }));
    reply('POST /bible/resolve', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation()));
    const editor = await openNote('See Rom 9:1 now');
    // A leading and a trailing space selected along with the reference.
    select(editor, ' Rom 9:1 ');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve reference' }));

    await waitFor(() => expect(textOf(resolveStatus())).toContain('Linked Romans 9:1.'));
    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved), {
      timeout: 3000,
    });
    expect(
      requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.body]),
    ).toStrictEqual([
      ['POST', '/bible/resolve', { input: 'Rom 9:1', editionId: TRANSLATION.id }],
      ['PATCH', NOTE, { expectedRevision: 1, content: linked('See ', ' now') }],
    ]);
  });

  it('keeps a note with a reference link savable after bold or italic is applied over all of it', async () => {
    reply(`GET ${NOTES}`, jsonResponse(200, { items: [summary()] }));
    reply(`GET ${NOTE}`, jsonResponse(200, note({ content: linked('See ', ' now') })));
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation()));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'First thoughts' }));
    const editor = await noteEditor();
    act(() => {
      editor.chain().selectAll().toggleBold().toggleItalic().run();
    });

    await waitFor(() => expect(textOf(saveStatus())).toContain(SAVE_COPY.saved), {
      timeout: 3000,
    });
    const bold = [{ type: 'bold' }, { type: 'italic' }];
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toStrictEqual([
      {
        expectedRevision: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ', marks: bold },
                // The link itself takes no marks: the allowlist carries none on it.
                {
                  type: 'scriptureReference',
                  attrs: { referenceId: ROMANS.id, label: ROMANS.label },
                },
                { type: 'text', text: ' now', marks: bold },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('offers the candidates of an ambiguous book and links only the one chosen', async () => {
    reply('GET /bible/translations', jsonResponse(200, { translations: [TRANSLATION] }));
    reply(
      'POST /bible/resolve',
      jsonResponse(200, {
        outcome: 'ambiguous',
        candidates: [
          { bookCode: 'PHP', bookName: 'Philippians', input: 'PHP 1:1' },
          { bookCode: 'PHM', bookName: 'Philemon', input: 'PHM 1:1' },
        ],
      }),
      jsonResponse(200, { outcome: 'resolved', reference: { ...ROMANS, label: 'Romans 9:1' } }),
    );
    reply(`PATCH ${NOTE}`, jsonResponse(200, mutation()));
    const editor = await openNote('Ph 1:1');
    select(editor, 'Ph 1:1');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve reference' }));
    const group = await screen.findByRole('group', { name: 'Choose the book' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['Philippians', 'Philemon', 'Cancel']);
    fireEvent.click(within(group).getByRole('button', { name: 'Philippians' }));
    await waitFor(() => expect(textOf(resolveStatus())).toContain('Linked Romans 9:1.'));
    expect(requests.filter((r) => r.path === '/bible/resolve').map((r) => r.body)).toStrictEqual([
      { input: 'Ph 1:1', editionId: TRANSLATION.id },
      { input: 'PHP 1:1', editionId: TRANSLATION.id },
    ]);
  });

  it('leaves text that is not a reference, or an invalid one, exactly as typed', async () => {
    reply('GET /bible/translations', jsonResponse(200, { translations: [TRANSLATION] }));
    reply(
      'POST /bible/resolve',
      jsonResponse(200, { outcome: 'not_reference' }),
      jsonResponse(422, {
        code: 'REFERENCE_VERSE_OUT_OF_RANGE',
        message: 'x',
        retryable: false,
        correlationId: 'c',
      }),
    );
    const editor = await openNote('grace Rom 9:99');
    select(editor, 'grace');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve reference' }));
    await waitFor(() =>
      expect(textOf(resolveStatus())).toContain(
        'The selected text is not a Bible reference, so nothing was linked.',
      ),
    );
    select(editor, 'Rom 9:99');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve reference' }));
    await waitFor(() =>
      expect(textOf(resolveStatus())).toContain('That verse does not exist in this chapter.'),
    );
    expect(editor.getJSON()).toStrictEqual(doc('grace Rom 9:99'));
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('names Scripture targets in the list, and shows an open note’s passage with its quote, saying when it no longer matches', async () => {
    const target = (problem: string | null, anchorKind: string) => ({
      kind: 'scripture',
      anchorKind,
      reference: ROMANS,
      problem,
    });
    const anchor = {
      version: 1,
      editionId: TRANSLATION.id,
      bookCode: 'ROM',
      kind: 'phrase',
      segments: [{ chapter: 9, verse: 1, start: 0, end: 6, textSha256: 'a'.repeat(64) }],
      quote: 'I tell',
    };
    reply(
      `GET ${NOTES}`,
      jsonResponse(200, {
        items: [
          summary({ target: target(null, 'phrase') }),
          summary({
            id: 'cccccccc-2222-4333-8444-555555555555',
            preview: 'Second',
            target: target('ANCHOR_QUOTE_MISMATCH', 'verses'),
          }),
        ],
      }),
    );
    reply(
      `GET ${NOTE}`,
      jsonResponse(
        200,
        note({ target: target('ANCHOR_QUOTE_MISMATCH', 'phrase'), targetAnchor: anchor }),
      ),
    );
    reply('GET /bible/translations', jsonResponse(200, { translations: [TRANSLATION] }));
    renderPanel({ ...STUDY, lifecycle: 'archived' });
    const list = await screen.findByRole('list', { name: 'Notes' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => textOf(item)),
    ).toStrictEqual([
      expect.stringContaining('On a phrase in Romans 9:1 · Updated'),
      expect.stringContaining('On Romans 9:1 (no longer matches the text) · Updated'),
    ]);
    fireEvent.click(within(list).getByRole('button', { name: 'First thoughts' }));
    const passage = await screen.findByRole('region', { name: 'Attached passage' });
    await waitFor(() =>
      expect(textOf(passage)).toContain(
        `This note’s passage no longer matches the ${TRANSLATION.name} text.`,
      ),
    );
    expect({
      quote: textOf(passage.querySelector('blockquote')),
      reselect: within(passage)
        .getByRole('link', { name: 'Reselect Romans 9:1' })
        .getAttribute('href'),
    }).toStrictEqual({ quote: '“I tell”', reselect: `/bible?ref=${ROMANS.id}&study=${STUDY_ID}` });
  });
});
