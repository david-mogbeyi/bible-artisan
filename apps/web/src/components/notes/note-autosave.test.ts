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
import type { NoteDraft } from './note-document';

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
  targetReferenceId: null,
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

  let saved: [number, NoteDocument][];
  let lastState: SaveState;

  function autosave(content = doc(''), read?: () => NoteDraft) {
    return new NoteAutosave({
      revision: 1,
      content,
      send: (body, key) =>
        new Promise<NoteMutationResponse>((resolve, reject) => {
          sent.push({ body, key, resolve, reject });
        }),
      onState: (state) => {
        lastState = state;
        states.push(state.kind);
      },
      onSaved: (answer, acknowledged) => saved.push([answer.revision, acknowledged]),
      newKey: () => `key-${(keys += 1)}`,
      ...(read ? { read } : {}),
    });
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    states = [];
    keys = 0;
    saved = [];
    lastState = { kind: 'saved' };
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

  it('says a Bible reference link could not be verified (422 NOTE_REFERENCE_INVALID) and keeps the draft (BIB-24)', async () => {
    const saver = autosave();
    saver.edited(doc('x'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(422, { code: 'NOTE_REFERENCE_INVALID' }));
    await settle();
    expect([states.at(-1), saver.unsaved]).toStrictEqual(['invalid', true]);
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
  it('treats 422 NOTE_UNCHANGED as acknowledged: Saved, and no further request', async () => {
    const saver = autosave(doc('kept'));
    saver.edited(doc('same as the server'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(422, { code: 'NOTE_UNCHANGED' }));
    await settle();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS * 2);
    saver.dispose();
    expect([sent.length, states.at(-1), saver.unsaved]).toStrictEqual([1, 'saved', false]);
  });

  it('after 422 NOTE_UNCHANGED, sends only edits made meanwhile, once', async () => {
    const saver = autosave(doc('kept'));
    saver.edited(doc('one'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    saver.edited(doc('two'));
    sent[0]?.reject(new ApiError(422, { code: 'NOTE_UNCHANGED' }));
    await settle();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(sent.map((s) => s.body)).toStrictEqual([
      { expectedRevision: 1, content: doc('one') },
      { expectedRevision: 1, content: doc('two') },
    ]);
    sent[1]?.resolve(response(2));
    await settle();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_DELAY_MS);
    expect([sent.length, states.at(-1)]).toStrictEqual([2, 'saved']);
  });

  it('tells a note over the character limit (413 NOTE_TOO_LONG) from a request over the size limit (413 PAYLOAD_TOO_LARGE)', async () => {
    const saver = autosave();
    saver.edited(doc('x'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(new ApiError(413, { code: 'NOTE_TOO_LONG' }));
    await settle();
    expect(states.at(-1)).toBe('too_long');
    saver.edited(doc('y'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[1]?.reject(new ApiError(413, { code: 'PAYLOAD_TOO_LARGE' }));
    await settle();
    expect([states.at(-1), saver.unsaved]).toStrictEqual(['too_large', true]);
  });

  it('says which kind of content the server refused (400 field errors)', async () => {
    const saver = autosave();
    saver.edited(doc('x'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    sent[0]?.reject(
      new ApiError(400, {
        code: 'VALIDATION',
        fieldErrors: { 'content.content.0.content.0.marks.0.attrs.href': ['Invalid URL'] },
      }),
    );
    await settle();
    expect(lastState).toStrictEqual({ kind: 'invalid', problem: 'link' });
  });

  it('reads the editor only when a save is due, never per keystroke', async () => {
    const read = vi.fn((): NoteDraft => ({ ok: true, doc: doc('typed') }));
    const saver = autosave(doc(''), read);
    for (let i = 0; i < 20; i += 1) saver.touched(5);
    expect([read.mock.calls.length, states.at(-1), saver.unsaved]).toStrictEqual([
      0,
      'pending',
      true,
    ]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.body)).toStrictEqual([{ expectedRevision: 1, content: doc('typed') }]);
    // Over the limit shows at once, from the count alone.
    saver.touched(50_001);
    expect([read.mock.calls.length, states.at(-1)]).toStrictEqual([1, 'too_long']);
  });

  it('reports the acknowledged content with the revision it produced', async () => {
    const saver = autosave();
    saver.edited(doc('first'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    saver.edited(doc('second, typed during the save'));
    sent[0]?.resolve(response(2));
    await settle();
    sent[1]?.resolve(response(3));
    await settle();
    expect(saved).toStrictEqual([
      [2, doc('first')],
      [3, doc('second, typed during the save')],
    ]);
  });
});
