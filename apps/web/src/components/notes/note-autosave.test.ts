import type {
  NoteDocument,
  NoteMutationResponse,
  UpdateNoteRequest,
} from '@bible-artisan/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_DELAY_MS,
  NoteAutosave,
  type SaveState,
} from './note-autosave';

const doc = (text: string): NoteDocument => ({
  type: 'doc',
  content: [
    text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] },
  ],
});

const response = (revision: number, latestVersionNumber = 1): NoteMutationResponse => ({
  id: 'aaaaaaaa-2222-4333-8444-555555555555',
  studyId: 'bbbbbbbb-2222-4333-8444-555555555555',
  revision,
  targetNodeId: null,
  characterCount: 1,
  latestVersionNumber,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  deletedAt: null,
  lastEventSequence: '2',
});

interface Sent {
  body: UpdateNoteRequest;
  key: string;
  resolve: (value: NoteMutationResponse) => void;
  reject: (error: unknown) => void;
}

describe('NoteAutosave (BIB-23, PRD section 27)', () => {
  let sent: Sent[];
  let states: SaveState['kind'][];
  let keys: number;

  function autosave(content = doc('')) {
    return new NoteAutosave({
      revision: 1,
      content,
      send: (body, key) =>
        new Promise<NoteMutationResponse>((resolve, reject) => {
          sent.push({ body, key, resolve, reject });
        }),
      onState: (state) => states.push(state.kind),
      onSaved: () => undefined,
      newKey: () => `key-${(keys += 1)}`,
    });
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    states = [];
    keys = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves 750 ms after typing stops, and says Saved only once the server acknowledged it', async () => {
    const saver = autosave();
    saver.edited(doc('a'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1);
    saver.edited(doc('ab'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((s) => [s.body, s.key])).toStrictEqual([
      [{ expectedRevision: 1, content: doc('ab') }, 'key-1'],
    ]);
    expect(states.at(-1)).toBe('saving');
    sent[0]?.resolve(response(2));
    await settle();
    expect([states.at(-1), saver.unsaved, saver.currentRevision]).toStrictEqual([
      'saved',
      false,
      2,
    ]);
  });

  it('saves at most five seconds after the first change while typing continues', async () => {
    const saver = autosave();
    for (let elapsed = 0; elapsed < AUTOSAVE_MAX_DELAY_MS; elapsed += 500) {
      saver.edited(doc(`typing ${elapsed}`));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sent).toHaveLength(1);
  });

  it('keeps one request in flight and sends edits made meanwhile next, coalesced, on the new revision', async () => {
    const saver = autosave();
    saver.edited(doc('one'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    saver.edited(doc('two'));
    saver.edited(doc('three'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    expect(sent).toHaveLength(1);
    sent[0]?.resolve(response(2));
    await settle();
    expect(sent.map((s) => s.body)).toStrictEqual([
      { expectedRevision: 1, content: doc('one') },
      { expectedRevision: 2, content: doc('three') },
    ]);
    expect(states.at(-1)).toBe('saving');
  });

  it('resends the identical request with the same key after an unknown outcome, before anything newer', async () => {
    const saver = autosave();
    saver.edited(doc('first'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new TypeError('network down'));
    await settle();
    expect([states.at(-1), saver.unsaved]).toStrictEqual(['failed', true]);
    // Typing more does not discard the request that may have committed.
    saver.edited(doc('first and more'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(sent[1]).toMatchObject({ body: sent[0]?.body, key: 'key-1' });
    sent[1]?.resolve(response(2));
    await settle();
    expect(sent[2]).toMatchObject({
      body: { expectedRevision: 2, content: doc('first and more') },
      key: 'key-2',
    });
  });

  it('retries a 503 on request with the identical body and key', async () => {
    const saver = autosave();
    saver.edited(doc('x'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(503, { code: 'TRANSIENT_CONFLICT', retryable: true }));
    await settle();
    saver.flush();
    expect([sent[1]?.body, sent[1]?.key]).toStrictEqual([sent[0]?.body, sent[0]?.key]);
  });

  it('stops on a conflict and keeps the draft; Keep mine saves it as a new version on the current revision with a new key', async () => {
    const saver = autosave();
    saver.edited(doc('mine'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(409, { code: 'REVISION_CONFLICT', currentRevision: 5 }));
    await settle();
    saver.edited(doc('mine, still typing'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    expect([states.at(-1), sent.length, saver.unsaved]).toStrictEqual(['conflict', 1, true]);
    saver.keepMine(5);
    expect(sent[1]).toMatchObject({
      body: { expectedRevision: 5, content: doc('mine, still typing'), checkpoint: true },
      key: 'key-2',
    });
  });

  it('never sends a note over 50,000 characters and keeps it', async () => {
    const saver = autosave();
    saver.edited(doc('a'.repeat(50_001)));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    saver.flush();
    expect([sent.length, states.at(-1), saver.unsaved]).toStrictEqual([0, 'too_long', true]);
    saver.edited(doc('a'.repeat(50_000)));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(sent).toHaveLength(1);
  });

  it('stops on a lifecycle refusal and says which', async () => {
    const saver = autosave();
    saver.edited(doc('x'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(422, { code: 'STUDY_ARCHIVED' }));
    await settle();
    saver.edited(doc('y'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    expect([states.at(-1), sent.length]).toStrictEqual(['locked', 1]);
  });

  it('saves a version on request, and says when the newest version already holds the content', async () => {
    const saver = autosave(doc('saved'));
    saver.checkpoint();
    expect(sent[0]?.body).toStrictEqual({
      expectedRevision: 1,
      content: doc('saved'),
      checkpoint: true,
    });
    sent[0]?.reject(new ApiError(422, { code: 'NOTE_UNCHANGED' }));
    await settle();
    expect(states.at(-1)).toBe('already_versioned');
  });

  it('sends unsaved work when the editor closes', async () => {
    const saver = autosave();
    saver.edited(doc('leaving'));
    saver.dispose();
    expect(sent.map((s) => s.body)).toStrictEqual([
      { expectedRevision: 1, content: doc('leaving') },
    ]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    expect(sent).toHaveLength(1);
  });
});
