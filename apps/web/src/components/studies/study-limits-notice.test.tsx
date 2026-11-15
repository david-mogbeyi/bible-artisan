import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { StudyLimitsNotice } from './study-limits-notice';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const OK = {
  nodes: { used: 10, limit: 2000, state: 'ok' },
  edges: { used: 0, limit: 6000, state: 'ok' },
  events: { used: 12, limit: 100000, state: 'ok' },
  storage: { used: 1024, limit: 524288000, state: 'ok' },
};

function serve(body: unknown) {
  const fetchMock = vi.fn((input: string) => {
    if (input.endsWith(`/studies/${STUDY_ID}/limits`)) {
      return Promise.resolve(jsonResponse(200, body));
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudyLimitsNotice', () => {
  it('shows nothing while every count is below 80% of its cap', async () => {
    const fetchMock = serve(OK);
    renderWithQuery(<StudyLimitsNotice studyId={STUDY_ID} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let the query settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('heading', { name: /limit/i })).toBeNull();
  });

  it('warns from 80% and explains what still works at a cap, in words', async () => {
    serve({
      ...OK,
      nodes: { used: 1700, limit: 2000, state: 'warning' },
      events: { used: 100000, limit: 100000, state: 'reached' },
    });
    renderWithQuery(<StudyLimitsNotice studyId={STUDY_ID} />);
    expect(await screen.findByRole('heading', { name: 'Study limit reached' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => textOf(item))).toStrictEqual([
      'Near the node limit: 1,700 of 2,000 nodes in this study.',
      'History limit reached: this study has 100,000 recorded events, so additions are paused. Start a new study to continue.',
    ]);
    expect(
      screen.getByText(
        'You can still read, export, archive and delete. Only additions are paused.',
      ),
    ).toBeTruthy();
  });

  it('words a storage warning in megabytes', async () => {
    serve({ ...OK, storage: { used: 450 * 1024 * 1024, limit: 524288000, state: 'warning' } });
    renderWithQuery(<StudyLimitsNotice studyId={STUDY_ID} />);
    expect(await screen.findByRole('heading', { name: 'Approaching a study limit' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => textOf(item))).toStrictEqual([
      'Near your storage limit: 450 MB of 500 MB used across your studies.',
    ]);
  });
});
