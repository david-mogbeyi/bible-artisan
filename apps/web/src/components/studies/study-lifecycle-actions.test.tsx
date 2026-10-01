import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPurgeDate } from '@/lib/studies';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { ARCHIVED_ELSEWHERE } from './study-editor';
import {
  ARCHIVED_BANNER,
  CHANGED_ELSEWHERE,
  STATE_CHANGED_ELSEWHERE,
  UNSAVED_EDITS_BLOCK,
} from './study-lifecycle-actions';
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
const QUESTION = {
  nodeId: 'dddddddd-2222-4333-8444-555555555555',
  text: 'What is conscience?',
  status: 'open',
};
const PURGE_AT = '2026-10-31T12:00:00.000Z';
const ACTIVE = {
  id: STUDY_ID,
  title: 'Conscience and the Holy Spirit',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 1,
  contentRevision: 1,
  startingReference: null,
  mainQuestion: QUESTION,
  originalQuestion: QUESTION,
  tags: [],
  branchId: null,
  purgeAt: null as string | null,
  createdAt: '2026-10-01T12:00:00.000Z',
};
const ARCHIVED = { ...ACTIVE, lifecycle: 'archived', revision: 2 };
const TRASHED = { ...ACTIVE, lifecycle: 'trashed', revision: 2, purgeAt: PURGE_AT };

/** The 200 of a lifecycle route: the study as GET answers it, less the reference and createdAt. */
function changed(study: typeof ACTIVE, lastEventSequence = '3') {
  const { startingReference: _ref, createdAt: _created, ...rest } = study;
  return { ...rest, lastEventSequence };
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});

interface Sent {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

type Reply = Response | Error | Promise<Response>;
let reads: Reply[];
let writes: Reply[];
let sent: Sent[];

beforeEach(() => {
  reads = [];
  writes = [];
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const path = new URL(input, 'http://api.test').pathname.replace(/^\/v1/, '');
      if (path.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
      // The page's notes panel (BIB-23): no notes in these tests.
      if (path.includes('/notes')) return Promise.resolve(jsonResponse(200, { items: [] }));
      const method = init.method ?? 'GET';
      const queue = method === 'GET' ? reads : writes;
      if (method !== 'GET') {
        const headers = init.headers as Record<string, string>;
        sent.push({
          method,
          path,
          body: JSON.parse(init.body as string),
          key: headers['Idempotency-Key'],
        });
      }
      const next = queue.shift();
      if (!next) throw new Error(`unexpected ${method} ${path}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderStudy(study: object) {
  reads.push(jsonResponse(200, study));
  const rendered = renderWithQuery(<StudyPage />);
  await screen.findByRole('heading', { level: 1, name: ACTIVE.title });
  return rendered;
}

/** The lifecycle section's own polite status region. */
const status = () =>
  within(screen.getByRole('region', { name: 'Study status' })).getByRole('status');

describe('study lifecycle actions (BIB-22)', () => {
  /** Archive and Move to trash are blocked, described by the visible unsaved-changes note. */
  function expectBlocked(blocked: boolean) {
    for (const name of ['Archive', 'Move to trash']) {
      const button = screen.getByRole('button', { name });
      expect([
        button.getAttribute('aria-disabled'),
        button.getAttribute('aria-describedby'),
      ]).toStrictEqual(blocked ? ['true', expect.any(String)] : [null, null]);
      if (blocked) {
        expect(
          document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
        ).toBe(UNSAVED_EDITS_BLOCK);
      }
    }
    expect(screen.queryByText(UNSAVED_EDITS_BLOCK) !== null).toBe(blocked);
  }

  it('never discards unsaved editor changes: Archive and Move to trash are blocked with an explanation until they are saved or discarded', async () => {
    await renderStudy(ACTIVE);
    expectBlocked(false);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A better title' } });
    expectBlocked(true);

    // Presses do nothing: no request, no dialog, and the draft is still there.
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(screen.getByRole('dialog', { hidden: true }).hasAttribute('open')).toBe(false);
    expect(sent).toStrictEqual([]);
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('A better title');

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expectBlocked(false);

    // Saving clears it too, once the server has the change.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A better title' } });
    expectBlocked(true);
    writes.push(
      jsonResponse(200, { ...changed({ ...ACTIVE, title: 'A better title', revision: 2 }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expectBlocked(false));
    expect(screen.getByRole('heading', { level: 1, name: 'A better title' })).toBeTruthy();
  });

  it('stays blocked while a save whose outcome is unknown could still be retried, and clears once it is confirmed', async () => {
    await renderStudy(ACTIVE);
    writes.push(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Pin study' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    // The form itself is unchanged; the frozen pin is the unsaved work.
    expectBlocked(true);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(sent.map((s) => s.path)).toStrictEqual([`/studies/${STUDY_ID}`]);

    writes.push(jsonResponse(200, changed({ ...ACTIVE, pinned: true, revision: 2 })));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expectBlocked(false));
    // Retry resent the identical request, key included.
    expect(sent[1]).toStrictEqual(sent[0]);
  });

  it('archives an active study after the server answers: banner, no editor, Unarchive focused, library marked stale', async () => {
    const { queryClient } = await renderStudy(ACTIVE);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    expect(screen.getByRole('heading', { name: 'Edit study' })).toBeTruthy();

    let answer: (res: Response) => void = () => undefined;
    writes.push(new Promise<Response>((resolve) => (answer = resolve)));
    const archive = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(archive);
    // Pending: still focusable, marked aria-disabled, and a second press sends nothing.
    await waitFor(() => expect(archive.getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(archive);
    expect(screen.queryByText(ARCHIVED_BANNER)).toBeNull();
    answer(jsonResponse(200, changed(ARCHIVED)));

    const unarchive = await screen.findByRole('button', { name: 'Unarchive' });
    expect(sent).toStrictEqual([
      {
        method: 'POST',
        path: `/studies/${STUDY_ID}/archive`,
        body: { expectedRevision: 1 },
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(screen.getByText(ARCHIVED_BANNER)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Edit study' })).toBeNull();
    expect(screen.getByText('What is conscience?')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(unarchive));
    expect(status().textContent).toBe('Study archived. It is read-only until you unarchive it.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['studies', 'library'] });
  });

  it('shows a trashed study read-only with its deletion date, and restores it to its prior state', async () => {
    await renderStudy(TRASHED);
    expect(
      screen.getByText(`In trash. It will be permanently deleted on ${formatPurgeDate(PURGE_AT)}.`),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Edit study' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull();

    writes.push(jsonResponse(200, changed({ ...ACTIVE, revision: 3 })));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const archive = await screen.findByRole('button', { name: 'Archive' });
    expect(sent.map((s) => [s.method, s.path, s.body])).toStrictEqual([
      ['POST', `/studies/${STUDY_ID}/restore`, { expectedRevision: 2 }],
    ]);
    expect(screen.getByRole('heading', { name: 'Edit study' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(archive));
    expect(status().textContent).toBe('Study restored.');
  });

  it('confirms Move to trash in a labelled dialog: focus on Cancel, Escape and Cancel change nothing and return focus', async () => {
    await renderStudy(ARCHIVED);
    expect(screen.getByText(ARCHIVED_BANNER)).toBeTruthy();
    const trigger = screen.getByRole('button', { name: 'Move to trash' });

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Move this study to trash?' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText(/restore it from Trash for 30 days/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(sent).toStrictEqual([]);

    writes.push(jsonResponse(200, changed({ ...TRASHED, revision: 3 })));
    fireEvent.click(trigger);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(sent.map((s) => [s.method, s.path, s.body])).toStrictEqual([
      ['DELETE', `/studies/${STUDY_ID}`, { expectedRevision: 2 }],
    ]);
    await waitFor(() => expect(document.activeElement).toBe(restore));
    expect(screen.getByText(/^In trash\. It will be permanently deleted on/)).toBeTruthy();
    expect(status().textContent).toBe('Study moved to trash.');
  });

  it('tells a stale revision and a state changed elsewhere by code, never the server message, and Reload shows the latest', async () => {
    const { queryClient } = await renderStudy(ACTIVE);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    writes.push(jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 2 })));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(CHANGED_ELSEWHERE)).toBeTruthy();
    expect(screen.queryByText('server text, never shown')).toBeNull();

    writes.push(jsonResponse(422, envelope('LIFECYCLE_TRANSITION_INVALID')));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await screen.findByText(STATE_CHANGED_ELSEWHERE);
    expect(invalidate).not.toHaveBeenCalled();

    reads.push(jsonResponse(200, ARCHIVED));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText(ARCHIVED_BANNER)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the unavailable page when the study is gone (404), e.g. past its trash window', async () => {
    await renderStudy(TRASHED);
    writes.push(jsonResponse(404, envelope('NOT_FOUND')));
    reads.push(jsonResponse(404, envelope('NOT_FOUND')));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByRole('heading', { name: "This study isn't available." }),
    ).toBeTruthy();
  });

  it('retries a change whose outcome is unknown with the identical body and Idempotency-Key', async () => {
    await renderStudy(ACTIVE);
    writes.push(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const alert = await screen.findByRole('alert');
    writes.push(jsonResponse(200, changed(ARCHIVED)));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByText(ARCHIVED_BANNER);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toStrictEqual(sent[0]);
  });

  it('says in the editor when a save is refused because the study was archived elsewhere', async () => {
    await renderStudy(ACTIVE);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } });
    writes.push(jsonResponse(422, envelope('STUDY_ARCHIVED')));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(ARCHIVED_ELSEWHERE)).toBeTruthy();
    expect(screen.queryByText('server text, never shown')).toBeNull();
    reads.push(jsonResponse(200, ARCHIVED));
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(await screen.findByText(ARCHIVED_BANNER)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Edit study' })).toBeNull();
  });
});
