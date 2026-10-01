import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITION_ID } from '@/test/bible-fixtures';
import { jsonResponse, renderWithQuery } from '@/test/render';
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
const ROMANS = {
  id: 'bbbbbbbb-2222-4333-8444-555555555555',
  editionId: EDITION_ID,
  bookCode: 'ROM',
  startChapter: 9,
  startVerse: 1,
  endChapter: 9,
  endVerse: 1,
  label: 'Romans 9:1',
};
const STUDY = {
  id: STUDY_ID,
  title: 'Conscience and the Holy Spirit',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 1,
  contentRevision: 1,
  startingReference: ROMANS,
  mainQuestion: {
    nodeId: 'dddddddd-2222-4333-8444-555555555555',
    text: 'What is conscience?',
    status: 'open',
  },
  originalQuestion: {
    nodeId: 'dddddddd-2222-4333-8444-555555555555',
    text: 'What is conscience?',
    status: 'open',
  },
  tags: [],
  branchId: 'eeeeeeee-2222-4333-8444-555555555555',
  createdAt: '2026-10-01T12:00:00.000Z',
};

let studyReplies: Array<Response | Error>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  studyReplies = [];
  fetchMock = vi.fn((input: string) => {
    if (input.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
    if (input.endsWith(`/studies/${STUDY_ID}`)) {
      const next = studyReplies.shift();
      if (!next) throw new Error('unexpected study read');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const envelope = (code: string) => ({
  code,
  message: 'server text, never shown',
  retryable: code === 'TRANSIENT_CONFLICT',
  correlationId: 'x',
});

describe('StudyPage', () => {
  it('shows the saved title, starting passage and main question from the server', async () => {
    studyReplies.push(jsonResponse(200, STUDY));
    renderWithQuery(<StudyPage />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Conscience and the Holy Spirit' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Romans 9:1' }).getAttribute('href')).toBe(
      `/bible?ref=${ROMANS.id}`,
    );
    expect(screen.getByText('What is conscience?')).toBeTruthy();
  });

  it('shows "None yet" for a blank study\'s passage, question and tags', async () => {
    studyReplies.push(
      jsonResponse(200, {
        ...STUDY,
        title: 'Untitled study',
        startingReference: null,
        mainQuestion: null,
        originalQuestion: null,
        branchId: null,
      }),
    );
    renderWithQuery(<StudyPage />);
    expect(await screen.findByRole('heading', { name: 'Untitled study' })).toBeTruthy();
    expect(screen.getAllByText('None yet')).toHaveLength(3);
  });

  it('shows the neutral unavailable state for a missing or foreign study, with no retry', async () => {
    studyReplies.push(jsonResponse(404, envelope('NOT_FOUND')));
    renderWithQuery(<StudyPage />);
    expect(
      await screen.findByRole('heading', { name: "This study isn't available." }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('server text, never shown')).toBeNull();
  });

  it('offers Retry when loading fails, and shows the study once it loads', async () => {
    studyReplies.push(new TypeError('Failed to fetch'), jsonResponse(200, STUDY));
    renderWithQuery(<StudyPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load this study.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Conscience and the Holy Spirit' })).toBeTruthy(),
    );
  });
});
