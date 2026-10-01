import {
  EMPTY_NOTE_DOCUMENT,
  type NoteDocument,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { studyQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { SAVE_COPY } from './note-editor';
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
    fireEvent.change(screen.getByLabelText('Attach to'), { target: { value: 'main' } });
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
});
