import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { CONFLICT, RELOADED, TAG_ALREADY_ADDED } from './study-editor';
import { StudyPage } from './study-page';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ studyId: STUDY_ID }),
}));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const ORIGINAL = {
  nodeId: 'dddddddd-2222-4333-8444-555555555555',
  text: 'What is conscience?',
  status: 'open',
};
const LATER = {
  nodeId: 'ffffffff-2222-4333-8444-555555555555',
  text: 'How does the Spirit bear witness?',
  status: 'open',
};
const GRACE = { id: '11111111-2222-4333-8444-555555555555', name: 'Grace' };
const STUDY = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 1,
  contentRevision: 1,
  startingReference: null,
  mainQuestion: ORIGINAL,
  originalQuestion: ORIGINAL,
  tags: [GRACE],
  branchId: 'eeeeeeee-2222-4333-8444-555555555555',
  createdAt: '2026-10-01T12:00:00.000Z',
};

/** The PATCH response for a study state: every editable field plus the counters. */
const edited = (state: Record<string, unknown>, lastEventSequence = '2') => {
  const { startingReference: _ref, createdAt: _created, ...rest } = { ...STUDY, ...state };
  return { ...rest, lastEventSequence };
};

let studyReplies: Array<Response | Error>;
let patchReplies: Array<Response | Error | Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  studyReplies = [];
  patchReplies = [];
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
    if (input.endsWith(`/studies/${STUDY_ID}`)) {
      const next = init?.method === 'PATCH' ? patchReplies.shift() : studyReplies.shift();
      if (!next) throw new Error(`unexpected ${init?.method ?? 'GET'} of the study`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The PATCH requests sent: their bodies and Idempotency-Keys. */
function patches(): { body: unknown; key: string }[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => ({
      body: JSON.parse(init?.body as string) as unknown,
      key: (init?.headers as Record<string, string>)['Idempotency-Key'] as string,
    }));
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});

async function openStudy(study: Record<string, unknown> = STUDY) {
  studyReplies.push(jsonResponse(200, study));
  const view = renderWithQuery(<StudyPage />);
  await screen.findByRole('heading', { name: 'Edit study' });
  return view;
}

const field = (name: RegExp | string) => screen.getByRole('textbox', { name });
const save = () => screen.getByRole('button', { name: 'Save changes' });

describe('StudyEditor', () => {
  it('saves only the changed fields with the loaded revision and says Saved after the server answers', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: '  Conscience and the Spirit ' } });
    fireEvent.change(field('Add a tag'), { target: { value: '  holy   spirit ' } });
    fireEvent.keyDown(field('Add a tag'), { key: 'Enter' });
    expect(
      within(screen.getByRole('list', { name: 'Tags on this study' })).getByText('holy spirit'),
    ).toBeTruthy();

    patchReplies.push(
      jsonResponse(
        200,
        edited({
          title: 'Conscience and the Spirit',
          revision: 2,
          contentRevision: 2,
          tags: [GRACE, { id: '22222222-2222-4333-8444-555555555555', name: 'holy spirit' }],
        }),
      ),
    );
    fireEvent.click(save());

    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(patches()).toStrictEqual([
      {
        body: {
          expectedRevision: 1,
          title: 'Conscience and the Spirit',
          tags: ['Grace', 'holy spirit'],
        },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Conscience and the Spirit' }),
    ).toBeTruthy();
    expect(screen.getByText('Grace, holy spirit')).toBeTruthy();
  });

  it('keeps the save button focused and aria-disabled while saving, sending one request', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: 'New title' } });
    let answer: (response: Response) => void = () => undefined;
    patchReplies.push(new Promise<Response>((resolve) => (answer = resolve)));
    save().focus();
    fireEvent.click(save());

    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(save());
    fireEvent.click(save());
    expect(patches()).toHaveLength(1);

    answer(jsonResponse(200, edited({ title: 'New title', revision: 2, contentRevision: 2 })));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(save().getAttribute('aria-disabled')).toBeNull();
  });

  it('on a 409 keeps the draft, and after Reload latest sends only what the user changed on the new revision', async () => {
    await openStudy();
    fireEvent.change(field(/Description/), { target: { value: 'Romans first.' } });
    patchReplies.push(jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })));
    fireEvent.click(save());

    const alert = await screen.findByText(CONFLICT);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect((field(/Description/) as HTMLTextAreaElement).value).toBe('Romans first.');

    // Another tab renamed the study meanwhile.
    studyReplies.push(jsonResponse(200, { ...STUDY, title: 'Renamed elsewhere', revision: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(await screen.findByText(RELOADED)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Renamed elsewhere' })).toBeTruthy();
    expect((field(/Description/) as HTMLTextAreaElement).value).toBe('Romans first.');

    patchReplies.push(
      jsonResponse(
        200,
        edited({
          title: 'Renamed elsewhere',
          description: 'Romans first.',
          revision: 3,
          contentRevision: 3,
        }),
      ),
    );
    fireEvent.click(save());
    expect(await screen.findByText('Saved.')).toBeTruthy();
    // The untouched title is not sent, so the other tab's rename is not overwritten.
    expect(patches().map((p) => p.body)).toStrictEqual([
      { expectedRevision: 1, description: 'Romans first.' },
      { expectedRevision: 2, description: 'Romans first.' },
    ]);
  });

  it('keeps the conflict and the draft when Reload latest fails, and Retry reloads', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: 'Mine' } });
    patchReplies.push(jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })));
    fireEvent.click(save());
    await screen.findByText(CONFLICT);

    studyReplies.push(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(
      await screen.findByText("Couldn't load the latest study. Your edits are still here."),
    ).toBeTruthy();
    expect(screen.getByText(CONFLICT)).toBeTruthy();

    studyReplies.push(jsonResponse(200, { ...STUDY, revision: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(RELOADED)).toBeTruthy();
    expect((field('Title') as HTMLInputElement).value).toBe('Mine');
    expect(patches()).toHaveLength(1);
  });

  it('retries a failed save with the same Idempotency-Key, and uses a new one once the draft changes', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: 'Retry me' } });
    patchReplies.push(new TypeError('Failed to fetch'), new TypeError('Failed to fetch'));
    fireEvent.click(save());
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    await screen.findByRole('button', { name: 'Retry' });

    fireEvent.change(field('Title'), { target: { value: 'Retry me, edited' } });
    patchReplies.push(jsonResponse(200, edited({ title: 'Retry me, edited', revision: 2 })));
    fireEvent.click(save());
    expect(await screen.findByText('Saved.')).toBeTruthy();

    const [first, retried, changed] = patches();
    expect(retried).toStrictEqual(first);
    expect(changed?.key).not.toBe(first?.key);
    expect((field('Title') as HTMLInputElement).value).toBe('Retry me, edited');
  });

  it('pins at once with aria-pressed, keeping an unsaved title edit', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: 'Unsaved title' } });
    const pin = screen.getByRole('button', { name: 'Pin study' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    patchReplies.push(jsonResponse(200, edited({ pinned: true, revision: 2 })));
    fireEvent.click(pin);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pin study' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(patches().map((p) => p.body)).toStrictEqual([{ expectedRevision: 1, pinned: true }]);
    expect((field('Title') as HTMLInputElement).value).toBe('Unsaved title');
  });

  it('sets a new main question, then makes the original main again', async () => {
    await openStudy();
    fireEvent.change(field(/New main question/), { target: { value: LATER.text } });
    patchReplies.push(
      jsonResponse(200, edited({ mainQuestion: LATER, revision: 2, contentRevision: 2 })),
    );
    fireEvent.click(save());
    const restore = await screen.findByRole('button', {
      name: 'Make the original question main again',
    });
    expect((field(/New main question/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(ORIGINAL.text)).toBeTruthy();

    patchReplies.push(
      jsonResponse(200, edited({ mainQuestion: ORIGINAL, revision: 3, contentRevision: 3 }, '3')),
    );
    fireEvent.click(restore);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Make the original question main again' }),
      ).toBeNull(),
    );
    expect(patches().map((p) => p.body)).toStrictEqual([
      { expectedRevision: 1, mainQuestion: { text: LATER.text } },
      { expectedRevision: 2, mainQuestion: { nodeId: ORIGINAL.nodeId } },
    ]);
  });

  it('removes a tag with its labelled button, refuses a duplicate by key, and reports nothing to save locally', async () => {
    await openStudy();
    fireEvent.change(field('Add a tag'), { target: { value: 'GRACE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(screen.getByText(TAG_ALREADY_ADDED)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Grace' }));
    expect(document.activeElement).toBe(field('Add a tag'));
    expect(screen.queryByRole('list', { name: 'Tags on this study' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    fireEvent.click(save());
    expect(await screen.findByText('There are no changes to save.')).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it('refuses an empty title before sending, focusing the field', async () => {
    await openStudy();
    fireEvent.change(field('Title'), { target: { value: '   ' } });
    fireEvent.click(save());
    expect(await screen.findByText('Enter a title.')).toBeTruthy();
    expect(document.activeElement).toBe(field('Title'));
    expect(patches()).toHaveLength(0);
  });
});
