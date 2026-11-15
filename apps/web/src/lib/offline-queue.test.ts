import 'fake-indexeddb/auto';
import type {
  NoteDocument,
  NoteMutationResponse,
  UpdateNoteRequest,
} from '@bible-artisan/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-client';
import {
  clearOfflineQueue,
  listQueued,
  OFFLINE_QUEUE_MAX_AGE_MS,
  OFFLINE_QUEUE_MAX_PER_STUDY,
  queueNoteSave,
  replayNoteSave,
} from './offline-queue';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT = 'a0000000-0000-4000-8000-000000000002';
const STUDY = 's0000000-0000-4000-8000-000000000001';

const doc = (text: string): NoteDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const noteId = (n: number) => `n0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const response = (revision: number): NoteMutationResponse => ({
  id: noteId(1),
  studyId: STUDY,
  revision,
  targetNodeId: null,
  targetReferenceId: null,
  characterCount: 1,
  latestVersionNumber: 1,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  deletedAt: null,
  lastEventSequence: '2',
});
const queue = (n: number, overrides: Partial<Parameters<typeof queueNoteSave>[0]> = {}) =>
  queueNoteSave({
    accountId: ACCOUNT,
    studyId: STUDY,
    noteId: noteId(n),
    revision: 1,
    attempt: null,
    draft: doc(`draft ${n}`),
    ...overrides,
  });
const isDefinite = (error: unknown) =>
  error instanceof ApiError && error.status === 409 ? ('conflict' as const) : null;

describe('offline queue (BIB-36, PRD section 27)', () => {
  beforeEach(async () => {
    await clearOfflineQueue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps one entry per note, rewritten as edits coalesce, visible only to its own account', async () => {
    expect(await queue(1)).toBe('queued');
    expect(await queue(1, { draft: doc('newer') })).toBe('queued');
    const [entry, ...rest] = await listQueued(ACCOUNT);
    expect([rest.length, entry?.draft, entry?.noteId]).toStrictEqual([0, doc('newer'), noteId(1)]);
    expect(await listQueued(OTHER_ACCOUNT)).toStrictEqual([]);
  });

  it('refuses a 101st note in one study, but still rewrites a queued one', async () => {
    for (let n = 1; n <= OFFLINE_QUEUE_MAX_PER_STUDY; n += 1) {
      expect(await queue(n)).toBe('queued');
    }
    expect(await queue(OFFLINE_QUEUE_MAX_PER_STUDY + 1)).toBe('full');
    expect(await queue(1, { draft: doc('rewritten') })).toBe('queued');
    expect(await listQueued(ACCOUNT)).toHaveLength(OFFLINE_QUEUE_MAX_PER_STUDY);
  });

  it('refuses what would put the account over 5 MB', async () => {
    const big = doc('x'.repeat(3 * 1024 * 1024));
    expect(await queue(1, { draft: big })).toBe('queued');
    expect(await queue(2, { draft: big })).toBe('full');
    // Another account has its own budget.
    expect(await queue(3, { draft: big, accountId: OTHER_ACCOUNT })).toBe('queued');
  });

  it('drops entries older than seven days', async () => {
    const now = Date.now();
    await queue(1);
    vi.spyOn(Date, 'now').mockReturnValue(now + OFFLINE_QUEUE_MAX_AGE_MS + 60_000);
    expect(await listQueued(ACCOUNT)).toStrictEqual([]);
  });

  it('replays the frozen request with its own key, then the later draft from the revision it returned, and removes the entry', async () => {
    await queue(1, {
      attempt: { key: 'frozen-key', body: { expectedRevision: 1, content: doc('first') } },
      draft: doc('first, then more'),
    });
    const [entry] = await listQueued(ACCOUNT);
    const sent: [UpdateNoteRequest, string][] = [];
    const outcome = await replayNoteSave(
      entry!,
      (body, key) => {
        sent.push([body, key]);
        return Promise.resolve(response(sent.length + 1));
      },
      { isDefinite, newKey: () => 'draft-key' },
    );
    expect([outcome.kind, sent]).toStrictEqual([
      'synced',
      [
        [{ expectedRevision: 1, content: doc('first') }, 'frozen-key'],
        [{ expectedRevision: 2, content: doc('first, then more') }, 'draft-key'],
      ],
    ]);
    expect(await listQueued(ACCOUNT)).toStrictEqual([]);
  });

  it('keeps an entry whose replay is unknown, frozen with its key, and marks one refused with 409', async () => {
    await queue(1);
    const [entry] = await listQueued(ACCOUNT);
    const keys: string[] = [];
    const offline = await replayNoteSave(
      entry!,
      (_body, key) => {
        keys.push(key);
        return Promise.reject(new TypeError('Failed to fetch'));
      },
      { isDefinite, newKey: () => `key-${keys.length + 1}` },
    );
    const [kept] = await listQueued(ACCOUNT);
    expect([offline.kind, kept?.attempt?.key, kept?.draft]).toStrictEqual(['retry', 'key-1', null]);
    const conflict = await replayNoteSave(
      kept!,
      (_body, key) => {
        keys.push(key);
        return Promise.reject(new ApiError(409, { code: 'REVISION_CONFLICT' }));
      },
      { isDefinite },
    );
    const [marked] = await listQueued(ACCOUNT);
    expect([conflict.kind, keys, marked?.failed]).toStrictEqual([
      'failed',
      ['key-1', 'key-1'],
      'conflict',
    ]);
  });

  it('clears every account on sign-out', async () => {
    await queue(1);
    await queue(2, { accountId: OTHER_ACCOUNT });
    await clearOfflineQueue();
    expect([await listQueued(ACCOUNT), await listQueued(OTHER_ACCOUNT)]).toStrictEqual([[], []]);
  });
});
