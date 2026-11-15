import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateLibrary } from '@/lib/studies';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { Home } from './home';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const SIGN_OUT_ERROR = "You're still signed in. Something went wrong signing out. Try again.";

let logoutResponses: Array<Response | Error>;
let recentResponses: Array<Response | Error>;
let resumeResponses: Response[];
let fetchMock: ReturnType<typeof vi.fn>;
const EMPTY_LIBRARY = { items: [], nextCursor: null };
const QUESTION_ID = 'bbbbbbbb-2222-4333-8444-000000000001';
const OPEN_ID = 'bbbbbbbb-2222-4333-8444-000000000002';
const CONCLUSION_ID = 'bbbbbbbb-2222-4333-8444-000000000003';
const BRANCH_ID = 'cccccccc-2222-4333-8444-000000000001';
const REFERENCE_ID = 'dddddddd-2222-4333-8444-000000000001';
const EVENT_ID = 'eeeeeeee-2222-4333-8444-000000000001';

/** A saved resume card (BIB-34): deterministic, no AI. */
function resumeOf(studyId: string, overrides: object = {}) {
  return {
    studyId,
    title: 'Conscience in Romans',
    lifecycle: 'active',
    lastActivityAt: '2026-10-01T12:00:00.000Z',
    activeQuestion: { nodeId: QUESTION_ID, text: 'What does conscience witness?', status: 'open' },
    activeBranch: { id: BRANCH_ID, rootNodeId: QUESTION_ID, rootLabel: 'Conscience' },
    lastPassage: {
      referenceId: REFERENCE_ID,
      label: 'Romans 8:16',
      eventId: EVENT_ID,
      occurredAt: '2026-10-01T11:00:00.000Z',
    },
    recentConclusion: {
      nodeId: CONCLUSION_ID,
      text: 'The Spirit bears witness',
      status: 'supported',
    },
    openQuestions: {
      items: [
        { nodeId: QUESTION_ID, text: 'What does conscience witness?' },
        { nodeId: OPEN_ID, text: 'Whose witness is it?' },
      ],
      total: 4,
    },
    target: {
      kind: 'node',
      nodeId: QUESTION_ID,
      referenceId: null,
      branchId: BRANCH_ID,
      fallback: false,
    },
    viewState: {
      viewRevision: 2,
      selectedNodeId: QUESTION_ID,
      activeBranchId: BRANCH_ID,
      activeQuestionNodeId: QUESTION_ID,
      readerReferenceId: null,
      viewport: null,
      panes: null,
      contextSavedAt: '2026-10-01T12:00:00.000Z',
    },
    ...overrides,
  };
}

beforeEach(() => {
  replace.mockReset();
  logoutResponses = [];
  recentResponses = [];
  resumeResponses = [];
  fetchMock = vi.fn((input: string) => {
    if (input.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
    if (input.endsWith('/health')) {
      return Promise.resolve(
        jsonResponse(200, {
          status: 'ok',
          database: 'up',
          migrations: 'current',
          corpus: 'ready',
        }),
      );
    }
    if (input.includes('/studies?')) {
      const next = recentResponses.shift() ?? jsonResponse(200, EMPTY_LIBRARY);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    if (input.includes('/resume')) {
      const id = /\/studies\/([^/]+)\/resume/.exec(input)?.[1] ?? '';
      return Promise.resolve(resumeResponses.shift() ?? jsonResponse(200, resumeOf(id)));
    }
    if (input.endsWith('/auth/logout')) {
      const next = logoutResponses.shift();
      if (!next) throw new Error('unexpected logout call');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSignedIn() {
  const rendered = renderWithQuery(<Home />);
  await screen.findByText('Signed in as reader@example.test');
  await screen.findByText('API ok · database up');
  return rendered;
}

const logoutCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/auth/logout'));

describe('Home sign-out', () => {
  it('clears cached private data and goes to sign-in once logout succeeds', async () => {
    logoutResponses.push(jsonResponse(204, null));
    const { queryClient } = await renderSignedIn();
    const clear = vi.spyOn(queryClient, 'clear');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(logoutCalls()).toHaveLength(1);
    const [, init] = logoutCalls()[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [
      'a server error',
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        retryable: true,
        correlationId: '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42',
      }),
    ],
    ['a network failure', new TypeError('Failed to fetch')],
  ])(
    'stays signed in on the page with a focused alert after %s, and can retry',
    async (_label, failure) => {
      logoutResponses.push(failure);
      const { queryClient } = await renderSignedIn();
      const clear = vi.spyOn(queryClient, 'clear');

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(SIGN_OUT_ERROR);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(replace).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(['me'])).toStrictEqual(ME);
      expect(screen.getByText('Signed in as reader@example.test')).toBeTruthy();

      // Retrying works once the API recovers.
      logoutResponses.push(jsonResponse(204, null));
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
      expect(logoutCalls()).toHaveLength(2);
    },
  );
});

describe('Home navigation', () => {
  it('offers New study and Read the Bible', async () => {
    await renderSignedIn();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'New study' }).getAttribute('href')).toBe(
      '/studies/new',
    );
    expect(within(nav).getByRole('link', { name: 'Read the Bible' }).getAttribute('href')).toBe(
      '/bible',
    );
  });
});

describe('Home recent studies', () => {
  const study = (n: number, pinned = false) => ({
    id: `aaaaaaaa-2222-4333-8444-${String(n).padStart(12, '0')}`,
    title: `Study ${n}`,
    pinned,
    lifecycle: 'active',
    startingReference: null,
    tags: [],
    lastActivityAt: '2026-10-01T12:00:00.000Z',
    createdAt: '2026-09-30T12:00:00.000Z',
    purgeAt: null,
    matchedInNotes: false,
  });

  it('asks for the three most recently active studies whatever their pin, shows them in that order, and links to the library', async () => {
    // A pinned study is recent only by its activity: here it is second, not first.
    recentResponses.push(
      jsonResponse(200, { items: [study(1), study(2, true), study(3)], nextCursor: 'more' }),
    );
    await renderSignedIn();
    const section = screen.getByRole('region', { name: 'Recent studies' });
    const links = await within(section).findAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toStrictEqual([
      ['Study 1', `/studies/${study(1).id}`],
      ['Study 2', `/studies/${study(2).id}`],
      ['Study 3', `/studies/${study(3).id}`],
      ['All studies', '/studies'],
    ]);
    expect(within(section).getByText('· Pinned')).toBeTruthy();
    const request = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((input) => input.includes('/studies?'));
    expect(new URL(request ?? '', 'http://api.test').searchParams.toString()).toBe(
      'sort=recent&pinnedFirst=false&limit=3',
    );
  });

  it('refetches when the library is invalidated after a study is created or edited', async () => {
    recentResponses.push(jsonResponse(200, { items: [study(1)], nextCursor: null }));
    const { queryClient } = await renderSignedIn();
    const section = screen.getByRole('region', { name: 'Recent studies' });
    await within(section).findByRole('link', { name: 'Study 1' });
    recentResponses.push(jsonResponse(200, { items: [study(9), study(1)], nextCursor: null }));
    await act(() => invalidateLibrary(queryClient));
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toStrictEqual(['Study 9', 'Study 1', 'All studies']),
    );
  });

  it('says when there are no studies yet', async () => {
    await renderSignedIn();
    const section = screen.getByRole('region', { name: 'Recent studies' });
    expect(await within(section).findByText('No studies yet.')).toBeTruthy();
  });

  it('shows Continue studying for the latest study from saved state only, and resumes the saved question and branch in one link', async () => {
    recentResponses.push(jsonResponse(200, { items: [study(1), study(2)], nextCursor: null }));
    await renderSignedIn();
    const card = await screen.findByRole('region', { name: 'Continue studying' });
    expect(within(card).getByText('Conscience in Romans')).toBeTruthy();
    expect(
      within(card).getByText(/What does conscience witness\?/, { selector: 'dd' }),
    ).toBeTruthy();
    expect(within(card).getByText('Romans 8:16')).toBeTruthy();
    expect(within(card).getByText('(Supported)')).toBeTruthy();
    expect(within(card).getByText('Open questions (4)')).toBeTruthy();
    const id = study(1).id;
    const nav = within(card).getByRole('navigation', { name: 'Continue studying' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toStrictEqual([
      ['Resume from last point', `/studies/${id}?node=${QUESTION_ID}&branch=${BRANCH_ID}`],
      ['Open graph', `/studies/${id}`],
      ['Explore open questions', `/studies/${id}?node=${QUESTION_ID}&branch=${BRANCH_ID}`],
    ]);
    expect(within(card).getByRole('link', { name: 'View all open questions' })).toBeTruthy();
    // Only the latest study's card is read.
    const resumes = fetchMock.mock.calls.filter(([input]) => String(input).includes('/resume'));
    expect(resumes.map(([input]) => String(input))).toStrictEqual([
      expect.stringMatching(new RegExp(`/studies/${id}/resume$`)),
    ]);
  });

  it('says when the saved node was deleted and the card resumes at the nearest saved point', async () => {
    recentResponses.push(jsonResponse(200, { items: [study(1)], nextCursor: null }));
    resumeResponses.push(
      jsonResponse(
        200,
        resumeOf(study(1).id, {
          target: {
            kind: 'branch_root',
            nodeId: QUESTION_ID,
            referenceId: null,
            branchId: BRANCH_ID,
            fallback: true,
          },
        }),
      ),
    );
    await renderSignedIn();
    const card = await screen.findByRole('region', { name: 'Continue studying' });
    expect(
      within(card).getByText(
        'What you last had open was deleted, so this resumes at the nearest saved point.',
      ),
    ).toBeTruthy();
  });

  it('keeps a failure inside the section and retries', async () => {
    recentResponses.push(
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'server text',
        retryable: true,
        correlationId: 'x',
      }),
    );
    await renderSignedIn();
    const section = screen.getByRole('region', { name: 'Recent studies' });
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load your recent studies.");
    recentResponses.push(jsonResponse(200, { items: [study(7)], nextCursor: null }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(section).findByRole('link', { name: 'Study 7' })).toBeTruthy();
  });
});
