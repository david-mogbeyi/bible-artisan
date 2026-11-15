import type { StudyEventItem, StudyResponse } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '@/test/axe';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { ThreadPanel } from './thread-panel';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const ROMANS_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const STUDY = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 1,
  contentRevision: 1,
  startingReference: null,
  mainQuestion: null,
  originalQuestion: null,
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
} as unknown as StudyResponse;

const CORRELATION = 'cccccccc-2222-4333-8444-555555555555';

function event(n: number, overrides: Partial<StudyEventItem> = {}): StudyEventItem {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sequence: String(n),
    type: 'scripture_opened',
    visibility: 'visible',
    actorKind: 'user',
    occurredAt: '2026-11-01T10:00:00.000Z',
    recordedAt: '2026-11-01T10:00:00.000Z',
    sessionId: null,
    displayText: `Opened Romans 9:1 from search`,
    targetRef: { kind: 'reference', id: ROMANS_ID, label: 'Romans 9:1', deleted: false },
    originRef: { kind: 'search', ref: null },
    branchId: null,
    parentVisitEventId: null,
    correlationId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    delayedSync: false,
    ...overrides,
  };
}

let pages: Map<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pages = new Map();
  fetchMock = vi.fn((input: string) => {
    const url = new URL(input);
    const key = `${url.searchParams.get('filter')}|${url.searchParams.get('cursor') ?? ''}`;
    const page = pages.get(key);
    if (!url.pathname.endsWith(`/studies/${STUDY_ID}/events`) || !page) {
      throw new Error(`unexpected fetch ${input}`);
    }
    return Promise.resolve(jsonResponse(200, page));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThreadPanel', () => {
  it('reads one action as one card that expands to its raw records, labels delayed and deleted events, and loads older pages', async () => {
    pages.set('all|', {
      items: [
        event(4, {
          displayText: 'Changed the description',
          type: 'study_description_changed',
          correlationId: CORRELATION,
          targetRef: null,
          originRef: null,
        }),
        event(3, {
          displayText: 'Renamed the study',
          type: 'study_renamed',
          correlationId: CORRELATION,
          targetRef: null,
          originRef: null,
        }),
        event(2, { delayedSync: true }),
      ],
      nextCursor: 'next-page',
    });
    pages.set('all|next-page', {
      items: [
        event(1, {
          type: 'thought_created',
          displayText: 'Wrote a thought (deleted)',
          targetRef: {
            kind: 'node',
            id: 'dddddddd-2222-4333-8444-555555555555',
            label: null,
            deleted: true,
          },
          originRef: null,
        }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<ThreadPanel study={STUDY} />);

    const list = await screen.findByRole('list', { name: 'Thread events' });
    const cards = within(list).getAllByRole('article');
    // The two records of one edit read as one card, named by its first record.
    expect(cards.map((card) => textOf(card.querySelector('p')))).toStrictEqual([
      'Renamed the study',
      'Opened Romans 9:1 from search',
    ]);
    const [edit, visit] = cards;
    if (!edit || !visit) throw new Error('expected two cards');
    const details = within(edit).getByRole('button', { name: 'Show details (2 records)' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(within(edit).getByRole('list', { name: 'Raw records' }))
        .getAllByRole('listitem')
        .map((item) => textOf(item).split(' · ').slice(0, 2).join(' · ')),
    ).toStrictEqual(['#4 · study_description_changed', '#3 · study_renamed']);

    // A delayed visit says so; opening it from the thread names this event as the origin.
    expect(within(visit).getByText('Synced later')).toBeTruthy();
    expect(within(visit).getByRole('link', { name: 'Open passage' }).getAttribute('href')).toBe(
      `/bible?ref=${ROMANS_ID}&study=${STUDY_ID}&from=${event(2).id}`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more events' }));
    const tombstone = await screen.findByText('Wrote a thought (deleted)');
    const card = tombstone.closest('article');
    if (!card) throw new Error('expected a card');
    expect(within(card).getByText('No longer in the graph')).toBeTruthy();
    expect(within(card).queryByRole('link', { name: 'Show in study' })).toBeNull();
    await expectNoA11yViolations(document.body);
    expect(screen.queryByRole('button', { name: 'Load more events' })).toBeNull();
  });

  it('names an action that accepted an AI suggestion by its acceptance, so the card shows the AI origin (FR-AI-013)', async () => {
    const accepted = 'eeeeeeee-2222-4333-8444-555555555555';
    pages.set('all|', {
      items: [
        event(6, {
          type: 'ai_suggestion_accepted',
          displayText: 'Added the AI-suggested question “What does the passage add?”',
          correlationId: accepted,
          targetRef: null,
          originRef: null,
        }),
        event(5, {
          type: 'question_created',
          displayText: 'Asked “What does the passage add?”',
          correlationId: accepted,
          targetRef: null,
          originRef: null,
        }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<ThreadPanel study={STUDY} />);
    const list = await screen.findByRole('list', { name: 'Thread events' });
    expect(
      within(list)
        .getAllByRole('article')
        .map((card) => textOf(card.querySelector('p'))),
    ).toStrictEqual(['Added the AI-suggested question “What does the passage add?”']);
  });

  it('filters the thread and explains an empty one', async () => {
    pages.set('all|', { items: [event(1)], nextCursor: null });
    pages.set('conclusions|', { items: [], nextCursor: null });
    renderWithQuery(<ThreadPanel study={STUDY} />);
    expect(await screen.findByText('Opened Romans 9:1 from search')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'conclusions' } });
    expect(
      await screen.findByText(
        'Nothing recorded here yet. What you do in this study is captured automatically.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string][]).map(([input]) =>
          new URL(input).searchParams.get('filter'),
        ),
      ).toStrictEqual(['all', 'conclusions']),
    );
  });

  it('marks where one recorded study session gives way to an earlier one (BIB-33)', async () => {
    const later = 'dddddddd-2222-4333-8444-000000000002';
    const earlier = 'dddddddd-2222-4333-8444-000000000001';
    pages.set('all|', {
      items: [
        event(3, { sessionId: later }),
        event(2, { sessionId: earlier }),
        event(1, { sessionId: earlier }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<ThreadPanel study={STUDY} />);
    const list = await screen.findByRole('list', { name: 'Thread events' });
    expect(within(list).getAllByText('Earlier study session')).toHaveLength(1);
  });
});
