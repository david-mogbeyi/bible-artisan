import 'fake-indexeddb/auto';
import type { NoteDocument } from '@bible-artisan/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { clearOfflineQueue, listQueued, queueNoteSave } from '@/lib/offline-queue';
import { captureDownloads } from '@/test/downloads';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { OFFLINE_SYNC_COPY, OfflineSync } from './offline-sync';

const ACCOUNT = '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60';
const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NOTE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const NOTE = `/studies/${STUDY_ID}/notes/${NOTE_ID}`;

const doc = (text: string): NoteDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const mutation = (revision: number) => ({
  id: NOTE_ID,
  studyId: STUDY_ID,
  revision,
  targetNodeId: null,
  targetReferenceId: null,
  characterCount: 5,
  latestVersionNumber: 1,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  deletedAt: null,
  lastEventSequence: '9',
});

let requests: { method: string; path: string; body: unknown; key: string | undefined }[];
let answers: Response[];
let online: MockInstance<() => boolean>;

beforeEach(async () => {
  await clearOfflineQueue();
  requests = [];
  answers = [];
  online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({
        method: init.method ?? 'GET',
        path: new URL(input).pathname.replace(/^\/v1/, ''),
        body: init.body ? JSON.parse(init.body as string) : undefined,
        key: headers['Idempotency-Key'],
      });
      const next = answers.shift();
      return next ? Promise.resolve(next) : Promise.reject(new TypeError('Failed to fetch'));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const queueFrozen = () =>
  queueNoteSave({
    accountId: ACCOUNT,
    studyId: STUDY_ID,
    noteId: NOTE_ID,
    revision: 1,
    attempt: { key: 'frozen-key', body: { expectedRevision: 1, content: doc('Train') } },
    draft: null,
  });

describe('OfflineSync (BIB-36)', () => {
  it('says an edit waits while offline, then replays it once with its own key when back online', async () => {
    await queueFrozen();
    online.mockReturnValue(false);
    renderWithQuery(<OfflineSync accountId={ACCOUNT} />);
    const notice = await screen.findByRole('region', { name: 'Offline edits' });
    expect(textOf(notice)).toContain(OFFLINE_SYNC_COPY.waiting(1));
    expect(requests).toStrictEqual([]);

    answers.push(jsonResponse(200, mutation(2)));
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Offline edits' })).toBeNull());
    expect(requests).toStrictEqual([
      {
        method: 'PATCH',
        path: NOTE,
        body: { expectedRevision: 1, content: doc('Train') },
        key: 'frozen-key',
      },
    ]);
    expect(await listQueued(ACCOUNT)).toStrictEqual([]);
  });

  it('keeps an edit refused with a conflict, offers it as a download, and never replays it again', async () => {
    await queueFrozen();
    answers.push(
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'x',
        currentRevision: 4,
      }),
    );
    renderWithQuery(<OfflineSync accountId={ACCOUNT} />);
    expect(await screen.findByText(OFFLINE_SYNC_COPY.failed(1))).toBeTruthy();
    const created = captureDownloads();
    fireEvent.click(screen.getByRole('button', { name: OFFLINE_SYNC_COPY.download }));
    const file = JSON.parse(await created[0]!.text()) as { drafts: { text: string }[] };
    expect(file.drafts.map((d) => d.text)).toStrictEqual(['Train']);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    fireEvent.click(screen.getByRole('button', { name: OFFLINE_SYNC_COPY.discard }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Offline edits' })).toBeNull());
    expect(requests).toHaveLength(1);
  });

  it("never shows or replays another account's queued edits", async () => {
    await queueFrozen();
    renderWithQuery(<OfflineSync accountId="11111111-2222-4333-8444-555555555555" />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect([screen.queryByRole('region', { name: 'Offline edits' }), requests]).toStrictEqual([
      null,
      [],
    ]);
  });
});
